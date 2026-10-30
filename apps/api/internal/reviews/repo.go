package reviews

import (
	"context"
	"encoding/json"
	"errors"
	"math"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/postwave/postwave/apps/api/internal/db"
)

type rowScanner interface {
	Scan(dest ...any) error
}

func (r *Repo) ListReviews(ctx context.Context, tenantID, status, productID string) ([]Review, error) {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	rows, err := tx.Query(ctx, reviewSelect()+`
WHERE tenant_id = $1::uuid
  AND ($2 = '' OR status = $2)
  AND ($3 = '' OR product_id::text = $3)
ORDER BY submitted_at DESC
LIMIT 200`, tenantID, strings.TrimSpace(status), strings.TrimSpace(productID))
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Review{}
	for rows.Next() {
		item, err := scanReview(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, *item)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return out, tx.Commit(ctx)
}

func (r *Repo) CreateReview(ctx context.Context, tenantID string, in Review) (*Review, error) {
	normalizeReview(&in)
	meta, _ := json.Marshal(in.Metadata)
	raw, _ := json.Marshal(in.RawPayload)
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	row := tx.QueryRow(ctx, `
INSERT INTO product_reviews
    (tenant_id, product_id, variant_id, request_id, order_id, source_platform,
     customer_id, source_ref, review_type, reviewer_name, reviewer_email,
     rating, title, body, status, verified_buyer, incentivized, featured,
     moderation_reason, submitted_at, published_at, moderated_at, metadata,
     raw_payload)
VALUES
    ($1::uuid, NULLIF($2,'')::uuid, NULLIF($3,'')::uuid, NULLIF($4,'')::uuid,
     NULLIF($5,'')::uuid, $6, NULLIF($7,'')::uuid, $8, $9, $10,
     NULLIF($11,'')::citext, $12, $13, $14, $15, $16, $17, $18, $19,
     COALESCE(NULLIF($20,'')::timestamptz, now()),
     CASE WHEN $15 = 'approved' THEN COALESCE(NULLIF($20,'')::timestamptz, now()) ELSE NULL END,
     CASE WHEN $15 IN ('approved','rejected','spam') THEN now() ELSE NULL END,
     $21::jsonb, $22::jsonb)
ON CONFLICT (tenant_id, source_platform, source_ref) WHERE (source_ref <> '') DO UPDATE SET
    product_id = COALESCE(EXCLUDED.product_id, product_reviews.product_id),
    order_id = COALESCE(EXCLUDED.order_id, product_reviews.order_id),
    customer_id = COALESCE(EXCLUDED.customer_id, product_reviews.customer_id),
    submitted_at = COALESCE(NULLIF($20,'')::timestamptz, product_reviews.submitted_at),
    rating = EXCLUDED.rating,
    title = EXCLUDED.title,
    body = EXCLUDED.body,
    status = EXCLUDED.status,
    metadata = EXCLUDED.metadata,
    raw_payload = EXCLUDED.raw_payload,
    updated_at = now()
`+reviewReturning(),
		tenantID, in.ProductID, in.VariantID, in.RequestID, in.OrderID,
		in.SourcePlatform, in.CustomerID, in.SourceRef, in.ReviewType, in.ReviewerName,
		in.ReviewerEmail, in.Rating, in.Title, in.Body, in.Status,
		in.VerifiedBuyer, in.Incentivized, in.Featured, in.ModerationReason,
		reviewSubmittedAtParam(in.SubmittedAt), string(meta), string(raw))
	out, err := scanReview(row)
	if err != nil {
		return nil, err
	}
	if out.ProductID != "" {
		if err := recomputeAggregateTx(ctx, tx, tenantID, out.ProductID); err != nil {
			return nil, err
		}
	}
	return out, tx.Commit(ctx)
}

func (r *Repo) GetReview(ctx context.Context, tenantID, id string) (*Review, error) {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	out, err := getReviewTx(ctx, tx, tenantID, id)
	if err != nil {
		return nil, err
	}
	replies, err := listRepliesTx(ctx, tx, tenantID, id)
	if err != nil {
		return nil, err
	}
	out.PublicReplies = replies
	return out, tx.Commit(ctx)
}

func (r *Repo) UpdateReview(ctx context.Context, tenantID, id string, in Review) (*Review, error) {
	normalizeReview(&in)
	meta, _ := json.Marshal(in.Metadata)
	raw, _ := json.Marshal(in.RawPayload)
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	row := tx.QueryRow(ctx, `
UPDATE product_reviews
SET product_id = NULLIF($3,'')::uuid,
    variant_id = NULLIF($4,'')::uuid,
    request_id = NULLIF($5,'')::uuid,
    order_id = NULLIF($6,'')::uuid,
    customer_id = NULLIF($7,'')::uuid,
    source_platform = $8,
    source_ref = $9,
    review_type = $10,
    reviewer_name = $11,
    reviewer_email = NULLIF($12,'')::citext,
    rating = $13,
    title = $14,
    body = $15,
    status = $16,
    verified_buyer = $17,
    incentivized = $18,
    featured = $19,
    moderation_reason = $20,
    submitted_at = COALESCE(NULLIF($21,'')::timestamptz, submitted_at),
    metadata = $22::jsonb,
    raw_payload = $23::jsonb,
    published_at = CASE WHEN $16 = 'approved' THEN COALESCE(published_at, now()) ELSE published_at END,
    moderated_at = CASE WHEN $16 IN ('approved','rejected','spam') THEN now() ELSE moderated_at END,
    updated_at = now()
WHERE tenant_id = $1::uuid AND id = $2::uuid
`+reviewReturning(),
		tenantID, id, in.ProductID, in.VariantID, in.RequestID, in.OrderID,
		in.CustomerID, in.SourcePlatform, in.SourceRef, in.ReviewType, in.ReviewerName,
		in.ReviewerEmail, in.Rating, in.Title, in.Body, in.Status,
		in.VerifiedBuyer, in.Incentivized, in.Featured, in.ModerationReason,
		reviewSubmittedAtParam(in.SubmittedAt), string(meta), string(raw))
	out, err := scanReview(row)
	if err != nil {
		return nil, mapNoRows(err)
	}
	if out.ProductID != "" {
		if err := recomputeAggregateTx(ctx, tx, tenantID, out.ProductID); err != nil {
			return nil, err
		}
	}
	return out, tx.Commit(ctx)
}

func (r *Repo) ModerateReview(ctx context.Context, tenantID, id, status string) (*Review, error) {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	row := tx.QueryRow(ctx, `
UPDATE product_reviews
SET status = $3,
    published_at = CASE WHEN $3 = 'approved' THEN COALESCE(published_at, now()) ELSE published_at END,
    moderated_at = now(),
    updated_at = now()
WHERE tenant_id = $1::uuid AND id = $2::uuid
`+reviewReturning(), tenantID, id, status)
	out, err := scanReview(row)
	if err != nil {
		return nil, mapNoRows(err)
	}
	if out.ProductID != "" {
		if err := recomputeAggregateTx(ctx, tx, tenantID, out.ProductID); err != nil {
			return nil, err
		}
	}
	return out, tx.Commit(ctx)
}

func (r *Repo) ProductSummary(ctx context.Context, tenantID, productID string) (*Summary, error) {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	out, err := productSummaryTx(ctx, tx, tenantID, productID)
	if err != nil {
		return nil, err
	}
	return out, tx.Commit(ctx)
}

func (r *Repo) CreateMedia(ctx context.Context, tenantID string, in Media) (*Media, error) {
	normalizeMedia(&in)
	meta, _ := json.Marshal(in.Metadata)
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := getReviewTx(ctx, tx, tenantID, in.ReviewID); err != nil {
		return nil, err
	}
	row := tx.QueryRow(ctx, `
INSERT INTO product_review_media
    (tenant_id, review_id, storage_key, public_url, mime_type, size_bytes,
     width, height, status, sort_order, metadata)
VALUES
    ($1::uuid, $2::uuid, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb)
RETURNING id::text, tenant_id::text, review_id::text, storage_key, public_url,
       mime_type, size_bytes, width, height, status, sort_order, metadata,
       created_at, updated_at`,
		tenantID, in.ReviewID, in.StorageKey, in.PublicURL, in.MimeType,
		in.SizeBytes, in.Width, in.Height, in.Status, in.SortOrder, string(meta))
	out, err := scanMedia(row)
	if err != nil {
		return nil, err
	}
	return out, tx.Commit(ctx)
}

func (r *Repo) CreateRequest(ctx context.Context, tenantID string, in ReviewRequest) (*ReviewRequest, error) {
	normalizeRequest(&in)
	meta, _ := json.Marshal(in.Metadata)
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	row := tx.QueryRow(ctx, `
INSERT INTO review_requests
    (tenant_id, product_id, variant_id, order_id, subscriber_id, email,
     token_hash, status, scheduled_at, sent_at, expires_at, channel, metadata)
VALUES
    ($1::uuid, NULLIF($2,'')::uuid, NULLIF($3,'')::uuid, NULLIF($4,'')::uuid,
     NULLIF($5,'')::uuid, NULLIF($6,'')::citext, $7, $8, $9, $10, $11, $12, $13::jsonb)
RETURNING id::text, tenant_id::text, COALESCE(product_id::text,''),
       COALESCE(variant_id::text,''), COALESCE(order_id::text,''),
       COALESCE(subscriber_id::text,''), COALESCE(email::text,''), token_hash,
       status, scheduled_at, sent_at, expires_at, channel, metadata, created_at, updated_at`,
		tenantID, in.ProductID, in.VariantID, in.OrderID, in.SubscriberID,
		in.Email, in.TokenHash, in.Status, in.ScheduledAt, in.SentAt,
		in.ExpiresAt, in.Channel, string(meta))
	out, err := scanRequest(row)
	if err != nil {
		return nil, err
	}
	return out, tx.Commit(ctx)
}

func (r *Repo) ListQuestions(ctx context.Context, tenantID, productID string) ([]Question, error) {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	rows, err := tx.Query(ctx, `
SELECT id::text, tenant_id::text, COALESCE(product_id::text,''), reviewer_name,
       COALESCE(reviewer_email::text,''), question, answer, status, answered_by,
       asked_at, answered_at, metadata, created_at, updated_at
FROM product_review_questions
WHERE tenant_id = $1::uuid AND ($2 = '' OR product_id::text = $2)
ORDER BY asked_at DESC
LIMIT 200`, tenantID, strings.TrimSpace(productID))
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Question{}
	for rows.Next() {
		item, err := scanQuestion(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, *item)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return out, tx.Commit(ctx)
}

func (r *Repo) CreateQuestion(ctx context.Context, tenantID string, in Question) (*Question, error) {
	normalizeQuestion(&in)
	meta, _ := json.Marshal(in.Metadata)
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	row := tx.QueryRow(ctx, `
INSERT INTO product_review_questions
    (tenant_id, product_id, reviewer_name, reviewer_email, question, answer,
     status, answered_by, answered_at, metadata)
VALUES
    ($1::uuid, NULLIF($2,'')::uuid, $3, NULLIF($4,'')::citext, $5, $6,
     $7, $8, CASE WHEN $6 <> '' THEN now() ELSE NULL END, $9::jsonb)
RETURNING id::text, tenant_id::text, COALESCE(product_id::text,''), reviewer_name,
       COALESCE(reviewer_email::text,''), question, answer, status, answered_by,
       asked_at, answered_at, metadata, created_at, updated_at`,
		tenantID, in.ProductID, in.ReviewerName, in.ReviewerEmail,
		in.Question, in.Answer, in.Status, in.AnsweredBy, string(meta))
	out, err := scanQuestion(row)
	if err != nil {
		return nil, err
	}
	return out, tx.Commit(ctx)
}

func (r *Repo) CreateReply(ctx context.Context, tenantID string, in PublicReply) (*PublicReply, error) {
	normalizeReply(&in)
	meta, _ := json.Marshal(in.Metadata)
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := getReviewTx(ctx, tx, tenantID, in.ReviewID); err != nil {
		return nil, err
	}
	row := tx.QueryRow(ctx, `
INSERT INTO review_public_replies (tenant_id, review_id, author, body, status, metadata)
VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6::jsonb)
RETURNING id::text, tenant_id::text, review_id::text, author, body, status,
       metadata, created_at, updated_at`,
		tenantID, in.ReviewID, in.Author, in.Body, in.Status, string(meta))
	out, err := scanReply(row)
	if err != nil {
		return nil, err
	}
	return out, tx.Commit(ctx)
}

func (r *Repo) ListWidgets(ctx context.Context, tenantID string) ([]Widget, error) {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	rows, err := tx.Query(ctx, widgetSelect()+`
WHERE tenant_id = $1::uuid
ORDER BY updated_at DESC`, tenantID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Widget{}
	for rows.Next() {
		item, err := scanWidget(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, *item)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return out, tx.Commit(ctx)
}

func (r *Repo) CreateWidget(ctx context.Context, tenantID string, in Widget) (*Widget, error) {
	normalizeWidget(&in)
	productFilter, _ := json.Marshal(in.ProductFilter)
	display, _ := json.Marshal(in.DisplaySettings)
	moderation, _ := json.Marshal(in.ModerationSettings)
	styling, _ := json.Marshal(in.Styling)
	meta, _ := json.Marshal(in.Metadata)
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	row := tx.QueryRow(ctx, `
INSERT INTO review_widgets
    (tenant_id, slug, name, status, widget_type, product_filter,
     display_settings, moderation_settings, language, styling, metadata)
VALUES
    ($1::uuid, $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8::jsonb, $9, $10::jsonb, $11::jsonb)
RETURNING id::text, tenant_id::text, slug::text, name, status, widget_type,
       product_filter, display_settings, moderation_settings, language, styling,
       metadata, created_at, updated_at`,
		tenantID, in.Slug, in.Name, in.Status, in.WidgetType,
		string(productFilter), string(display), string(moderation),
		in.Language, string(styling), string(meta))
	out, err := scanWidget(row)
	if err != nil {
		return nil, err
	}
	return out, tx.Commit(ctx)
}

func (r *Repo) GetWidget(ctx context.Context, tenantID, id string) (*Widget, error) {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	row := tx.QueryRow(ctx, widgetSelect()+`WHERE tenant_id = $1::uuid AND id = $2::uuid`, tenantID, id)
	out, err := scanWidget(row)
	if err != nil {
		return nil, mapNoRows(err)
	}
	return out, tx.Commit(ctx)
}

func (r *Repo) GetWidgetBySlugPublic(ctx context.Context, slug string) (*Widget, error) {
	tx, err := r.Pool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, "SELECT set_config('app.public_review_widget_slug', $1, true)", slug); err != nil {
		return nil, err
	}
	row := tx.QueryRow(ctx, widgetSelect()+`WHERE slug = $1::citext AND status = 'active'`, slug)
	out, err := scanWidget(row)
	if err != nil {
		return nil, mapNoRows(err)
	}
	return out, tx.Commit(ctx)
}

func (r *Repo) PublicWidgetData(ctx context.Context, tenantID, productID string) ([]PublicReview, *Summary, error) {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	rows, err := tx.Query(ctx, reviewSelect()+`
WHERE tenant_id = $1::uuid
  AND status = 'approved'
  AND ($2 = '' OR product_id::text = $2)
ORDER BY featured DESC, published_at DESC NULLS LAST
LIMIT 50`, tenantID, strings.TrimSpace(productID))
	if err != nil {
		return nil, nil, err
	}
	defer rows.Close()
	reviews := []Review{}
	public := []PublicReview{}
	for rows.Next() {
		item, err := scanReview(rows)
		if err != nil {
			return nil, nil, err
		}
		replies, err := listRepliesTx(ctx, tx, tenantID, item.ID)
		if err != nil {
			return nil, nil, err
		}
		item.PublicReplies = replies
		reviews = append(reviews, *item)
		public = append(public, ToPublicReview(item))
	}
	if err := rows.Err(); err != nil {
		return nil, nil, err
	}
	summary := SummaryFromReviews(productID, reviews)
	return public, &summary, tx.Commit(ctx)
}

func getReviewTx(ctx context.Context, tx pgx.Tx, tenantID, id string) (*Review, error) {
	row := tx.QueryRow(ctx, reviewSelect()+`WHERE tenant_id = $1::uuid AND id = $2::uuid`, tenantID, id)
	out, err := scanReview(row)
	return out, mapNoRows(err)
}

func productSummaryTx(ctx context.Context, tx pgx.Tx, tenantID, productID string) (*Summary, error) {
	row := tx.QueryRow(ctx, `
SELECT product_id::text, approved_count, rating_sum, average_rating::float8,
       rating_counts, last_review_at
FROM product_review_aggregates
WHERE tenant_id = $1::uuid AND product_id = $2::uuid`, tenantID, productID)
	var out Summary
	var counts []byte
	if err := row.Scan(&out.ProductID, &out.ApprovedCount, &out.RatingSum,
		&out.AverageRating, &counts, &out.LastReviewAt); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return &Summary{ProductID: productID, RatingCounts: emptyRatingCounts()}, nil
		}
		return nil, err
	}
	_ = json.Unmarshal(counts, &out.RatingCounts)
	if out.RatingCounts == nil {
		out.RatingCounts = emptyRatingCounts()
	}
	return &out, nil
}

func recomputeAggregateTx(ctx context.Context, tx pgx.Tx, tenantID, productID string) error {
	rows, err := tx.Query(ctx, reviewSelect()+`
WHERE tenant_id = $1::uuid AND product_id = $2::uuid`, tenantID, productID)
	if err != nil {
		return err
	}
	defer rows.Close()
	reviews := []Review{}
	for rows.Next() {
		item, err := scanReview(rows)
		if err != nil {
			return err
		}
		reviews = append(reviews, *item)
	}
	if err := rows.Err(); err != nil {
		return err
	}
	summary := SummaryFromReviews(productID, reviews)
	counts, _ := json.Marshal(summary.RatingCounts)
	avg := math.Round(summary.AverageRating*100) / 100
	_, err = tx.Exec(ctx, `
INSERT INTO product_review_aggregates
    (tenant_id, product_id, approved_count, rating_sum, average_rating, rating_counts, last_review_at)
VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6::jsonb, $7)
ON CONFLICT (tenant_id, product_id) DO UPDATE SET
    approved_count = EXCLUDED.approved_count,
    rating_sum = EXCLUDED.rating_sum,
    average_rating = EXCLUDED.average_rating,
    rating_counts = EXCLUDED.rating_counts,
    last_review_at = EXCLUDED.last_review_at,
    updated_at = now()`,
		tenantID, productID, summary.ApprovedCount, summary.RatingSum, avg, string(counts), summary.LastReviewAt)
	return err
}

func listRepliesTx(ctx context.Context, tx pgx.Tx, tenantID, reviewID string) ([]PublicReply, error) {
	rows, err := tx.Query(ctx, `
SELECT id::text, tenant_id::text, review_id::text, author, body, status,
       metadata, created_at, updated_at
FROM review_public_replies
WHERE tenant_id = $1::uuid AND review_id = $2::uuid AND status = 'published'
ORDER BY created_at ASC`, tenantID, reviewID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []PublicReply{}
	for rows.Next() {
		item, err := scanReply(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, *item)
	}
	return out, rows.Err()
}

func scanReview(row rowScanner) (*Review, error) {
	var out Review
	var meta, raw []byte
	if err := row.Scan(&out.ID, &out.TenantID, &out.ProductID, &out.VariantID,
		&out.RequestID, &out.OrderID, &out.SourcePlatform, &out.SourceRef,
		&out.CustomerID, &out.ReviewType, &out.ReviewerName, &out.ReviewerEmail,
		&out.Rating, &out.Title, &out.Body, &out.Status, &out.VerifiedBuyer,
		&out.Incentivized, &out.Featured, &out.ModerationReason,
		&out.SubmittedAt, &out.PublishedAt, &out.ModeratedAt, &meta,
		&raw, &out.CreatedAt, &out.UpdatedAt); err != nil {
		return nil, err
	}
	_ = json.Unmarshal(meta, &out.Metadata)
	_ = json.Unmarshal(raw, &out.RawPayload)
	if out.Metadata == nil {
		out.Metadata = map[string]any{}
	}
	if out.RawPayload == nil {
		out.RawPayload = map[string]any{}
	}
	return &out, nil
}

func reviewSubmittedAtParam(value time.Time) string {
	if value.IsZero() {
		return ""
	}
	return value.UTC().Format(time.RFC3339)
}

func scanMedia(row rowScanner) (*Media, error) {
	var out Media
	var meta []byte
	if err := row.Scan(&out.ID, &out.TenantID, &out.ReviewID,
		&out.StorageKey, &out.PublicURL, &out.MimeType, &out.SizeBytes,
		&out.Width, &out.Height, &out.Status, &out.SortOrder, &meta,
		&out.CreatedAt, &out.UpdatedAt); err != nil {
		return nil, err
	}
	_ = json.Unmarshal(meta, &out.Metadata)
	if out.Metadata == nil {
		out.Metadata = map[string]any{}
	}
	return &out, nil
}

func scanRequest(row rowScanner) (*ReviewRequest, error) {
	var out ReviewRequest
	var meta []byte
	if err := row.Scan(&out.ID, &out.TenantID, &out.ProductID, &out.VariantID,
		&out.OrderID, &out.SubscriberID, &out.Email, &out.TokenHash,
		&out.Status, &out.ScheduledAt, &out.SentAt, &out.ExpiresAt,
		&out.Channel, &meta, &out.CreatedAt, &out.UpdatedAt); err != nil {
		return nil, err
	}
	_ = json.Unmarshal(meta, &out.Metadata)
	if out.Metadata == nil {
		out.Metadata = map[string]any{}
	}
	return &out, nil
}

func scanQuestion(row rowScanner) (*Question, error) {
	var out Question
	var meta []byte
	if err := row.Scan(&out.ID, &out.TenantID, &out.ProductID,
		&out.ReviewerName, &out.ReviewerEmail, &out.Question, &out.Answer,
		&out.Status, &out.AnsweredBy, &out.AskedAt, &out.AnsweredAt,
		&meta, &out.CreatedAt, &out.UpdatedAt); err != nil {
		return nil, err
	}
	_ = json.Unmarshal(meta, &out.Metadata)
	if out.Metadata == nil {
		out.Metadata = map[string]any{}
	}
	return &out, nil
}

func scanReply(row rowScanner) (*PublicReply, error) {
	var out PublicReply
	var meta []byte
	if err := row.Scan(&out.ID, &out.TenantID, &out.ReviewID, &out.Author,
		&out.Body, &out.Status, &meta, &out.CreatedAt, &out.UpdatedAt); err != nil {
		return nil, err
	}
	_ = json.Unmarshal(meta, &out.Metadata)
	if out.Metadata == nil {
		out.Metadata = map[string]any{}
	}
	return &out, nil
}

func scanWidget(row rowScanner) (*Widget, error) {
	var out Widget
	var productFilter, display, moderation, styling, meta []byte
	if err := row.Scan(&out.ID, &out.TenantID, &out.Slug, &out.Name,
		&out.Status, &out.WidgetType, &productFilter, &display,
		&moderation, &out.Language, &styling, &meta, &out.CreatedAt,
		&out.UpdatedAt); err != nil {
		return nil, err
	}
	_ = json.Unmarshal(productFilter, &out.ProductFilter)
	_ = json.Unmarshal(display, &out.DisplaySettings)
	_ = json.Unmarshal(moderation, &out.ModerationSettings)
	_ = json.Unmarshal(styling, &out.Styling)
	_ = json.Unmarshal(meta, &out.Metadata)
	normalizeWidget(&out)
	return &out, nil
}

func normalizeRequest(in *ReviewRequest) {
	in.Email = strings.TrimSpace(strings.ToLower(in.Email))
	in.Status = defaulted(strings.TrimSpace(in.Status), "queued")
	in.Channel = defaulted(strings.TrimSpace(in.Channel), "email")
	if in.Metadata == nil {
		in.Metadata = map[string]any{}
	}
}

func normalizeQuestion(in *Question) {
	in.ReviewerEmail = strings.TrimSpace(strings.ToLower(in.ReviewerEmail))
	in.Status = defaulted(strings.TrimSpace(in.Status), "pending")
	if in.Answer != "" && in.Status == "pending" {
		in.Status = "answered"
	}
	if in.Metadata == nil {
		in.Metadata = map[string]any{}
	}
}

func normalizeReply(in *PublicReply) {
	in.Author = defaulted(strings.TrimSpace(in.Author), "Store owner")
	in.Status = defaulted(strings.TrimSpace(in.Status), "published")
	if in.Metadata == nil {
		in.Metadata = map[string]any{}
	}
}

func reviewSelect() string {
	return `
SELECT id::text, tenant_id::text, COALESCE(product_id::text,''),
       COALESCE(variant_id::text,''), COALESCE(request_id::text,''),
       COALESCE(order_id::text,''), source_platform, source_ref,
       COALESCE(customer_id::text,''), review_type, reviewer_name,
       COALESCE(reviewer_email::text,''), rating, title, body, status,
       verified_buyer, incentivized, featured, moderation_reason,
       submitted_at, published_at, moderated_at, metadata, raw_payload,
       created_at, updated_at
FROM product_reviews
`
}

func reviewReturning() string {
	return `
RETURNING id::text, tenant_id::text, COALESCE(product_id::text,''),
       COALESCE(variant_id::text,''), COALESCE(request_id::text,''),
       COALESCE(order_id::text,''), source_platform, source_ref,
       COALESCE(customer_id::text,''), review_type, reviewer_name,
       COALESCE(reviewer_email::text,''), rating, title, body, status,
       verified_buyer, incentivized, featured, moderation_reason,
       submitted_at, published_at, moderated_at, metadata, raw_payload,
       created_at, updated_at`
}

func widgetSelect() string {
	return `
SELECT id::text, tenant_id::text, slug::text, name, status, widget_type,
       product_filter, display_settings, moderation_settings, language,
       styling, metadata, created_at, updated_at
FROM review_widgets
`
}

func emptyRatingCounts() map[string]int {
	return map[string]int{"1": 0, "2": 0, "3": 0, "4": 0, "5": 0}
}

func mapNoRows(err error) error {
	if err == nil {
		return nil
	}
	if errors.Is(err, pgx.ErrNoRows) {
		return ErrNotFound
	}
	return err
}
