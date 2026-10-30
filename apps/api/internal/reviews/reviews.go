package reviews

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"html"
	"log/slog"
	"net/http"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"

	"github.com/postwave/postwave/apps/api/internal/apikeys"
	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/httpbody"
	"github.com/postwave/postwave/apps/api/internal/httperror"
	"github.com/postwave/postwave/apps/api/internal/middleware"
)

type Storage interface {
	PresignGet(ctx context.Context, tenantID, rest string, ttl time.Duration) (string, error)
}

type Deps struct {
	Repo       *Repo
	Storage    Storage
	PublicBase string
	Logger     *slog.Logger
	// FlowEvents, when set, lets native review submissions + review requests
	// trigger Klaviyo-style flows (review.submitted / review.requested). nil =
	// no flow triggers, matching the pre-wire behaviour.
	FlowEvents FlowEventEmitter
}

type Repo struct {
	Pool *db.Pool
}

type Widget struct {
	ID                 string         `json:"id,omitempty"`
	TenantID           string         `json:"tenant_id,omitempty"`
	Slug               string         `json:"slug,omitempty"`
	Name               string         `json:"name"`
	Status             string         `json:"status"`
	WidgetType         string         `json:"widget_type"`
	ProductFilter      map[string]any `json:"product_filter,omitempty"`
	DisplaySettings    map[string]any `json:"display_settings,omitempty"`
	ModerationSettings map[string]any `json:"moderation_settings,omitempty"`
	Language           string         `json:"language,omitempty"`
	Styling            map[string]any `json:"styling,omitempty"`
	Metadata           map[string]any `json:"metadata,omitempty"`
	PublicURL          string         `json:"public_url,omitempty"`
	CreatedAt          time.Time      `json:"created_at,omitempty"`
	UpdatedAt          time.Time      `json:"updated_at,omitempty"`
}

type Review struct {
	ID               string         `json:"id,omitempty"`
	TenantID         string         `json:"tenant_id,omitempty"`
	ProductID        string         `json:"product_id,omitempty"`
	VariantID        string         `json:"variant_id,omitempty"`
	RequestID        string         `json:"request_id,omitempty"`
	OrderID          string         `json:"order_id,omitempty"`
	CustomerID       string         `json:"customer_id,omitempty"`
	SourcePlatform   string         `json:"source_platform,omitempty"`
	SourceRef        string         `json:"source_ref,omitempty"`
	ReviewType       string         `json:"review_type"`
	ReviewerName     string         `json:"reviewer_name,omitempty"`
	ReviewerEmail    string         `json:"reviewer_email,omitempty"`
	Rating           int            `json:"rating"`
	Title            string         `json:"title,omitempty"`
	Body             string         `json:"body,omitempty"`
	Status           string         `json:"status"`
	VerifiedBuyer    bool           `json:"verified_buyer"`
	Incentivized     bool           `json:"incentivized"`
	Featured         bool           `json:"featured"`
	ModerationReason string         `json:"moderation_reason,omitempty"`
	SubmittedAt      time.Time      `json:"submitted_at,omitempty"`
	PublishedAt      *time.Time     `json:"published_at,omitempty"`
	ModeratedAt      *time.Time     `json:"moderated_at,omitempty"`
	Metadata         map[string]any `json:"metadata,omitempty"`
	RawPayload       map[string]any `json:"raw_payload,omitempty"`
	CreatedAt        time.Time      `json:"created_at,omitempty"`
	UpdatedAt        time.Time      `json:"updated_at,omitempty"`
	PublicReplies    []PublicReply  `json:"public_replies,omitempty"`
}

type PublicReview struct {
	ID            string        `json:"id"`
	ProductID     string        `json:"product_id,omitempty"`
	Rating        int           `json:"rating"`
	Title         string        `json:"title,omitempty"`
	Body          string        `json:"body,omitempty"`
	ReviewerName  string        `json:"reviewer_name,omitempty"`
	VerifiedBuyer bool          `json:"verified_buyer"`
	Incentivized  bool          `json:"incentivized"`
	Featured      bool          `json:"featured"`
	PublishedAt   *time.Time    `json:"published_at,omitempty"`
	PublicReplies []PublicReply `json:"public_replies,omitempty"`
}

type Media struct {
	ID           string         `json:"id,omitempty"`
	TenantID     string         `json:"tenant_id,omitempty"`
	ReviewID     string         `json:"review_id,omitempty"`
	StorageKey   string         `json:"storage_key"`
	PublicURL    string         `json:"public_url,omitempty"`
	MimeType     string         `json:"mime_type,omitempty"`
	SizeBytes    int64          `json:"size_bytes,omitempty"`
	Width        *int           `json:"width,omitempty"`
	Height       *int           `json:"height,omitempty"`
	Status       string         `json:"status"`
	SortOrder    int            `json:"sort_order,omitempty"`
	Metadata     map[string]any `json:"metadata,omitempty"`
	CreatedAt    time.Time      `json:"created_at,omitempty"`
	UpdatedAt    time.Time      `json:"updated_at,omitempty"`
	PresignedURL string         `json:"presigned_url,omitempty"`
}

type ReviewRequest struct {
	ID           string         `json:"id,omitempty"`
	TenantID     string         `json:"tenant_id,omitempty"`
	ProductID    string         `json:"product_id,omitempty"`
	VariantID    string         `json:"variant_id,omitempty"`
	OrderID      string         `json:"order_id,omitempty"`
	SubscriberID string         `json:"subscriber_id,omitempty"`
	Email        string         `json:"email,omitempty"`
	TokenHash    string         `json:"token_hash,omitempty"`
	Status       string         `json:"status"`
	ScheduledAt  *time.Time     `json:"scheduled_at,omitempty"`
	SentAt       *time.Time     `json:"sent_at,omitempty"`
	ExpiresAt    *time.Time     `json:"expires_at,omitempty"`
	Channel      string         `json:"channel"`
	Metadata     map[string]any `json:"metadata,omitempty"`
	CreatedAt    time.Time      `json:"created_at,omitempty"`
	UpdatedAt    time.Time      `json:"updated_at,omitempty"`
}

type Question struct {
	ID            string         `json:"id,omitempty"`
	TenantID      string         `json:"tenant_id,omitempty"`
	ProductID     string         `json:"product_id,omitempty"`
	ReviewerName  string         `json:"reviewer_name,omitempty"`
	ReviewerEmail string         `json:"reviewer_email,omitempty"`
	Question      string         `json:"question"`
	Answer        string         `json:"answer,omitempty"`
	Status        string         `json:"status"`
	AnsweredBy    string         `json:"answered_by,omitempty"`
	AskedAt       time.Time      `json:"asked_at,omitempty"`
	AnsweredAt    *time.Time     `json:"answered_at,omitempty"`
	Metadata      map[string]any `json:"metadata,omitempty"`
	CreatedAt     time.Time      `json:"created_at,omitempty"`
	UpdatedAt     time.Time      `json:"updated_at,omitempty"`
}

type PublicReply struct {
	ID        string         `json:"id,omitempty"`
	TenantID  string         `json:"tenant_id,omitempty"`
	ReviewID  string         `json:"review_id,omitempty"`
	Author    string         `json:"author,omitempty"`
	Body      string         `json:"body"`
	Status    string         `json:"status"`
	Metadata  map[string]any `json:"metadata,omitempty"`
	CreatedAt time.Time      `json:"created_at,omitempty"`
	UpdatedAt time.Time      `json:"updated_at,omitempty"`
}

type Summary struct {
	ProductID     string         `json:"product_id,omitempty"`
	ApprovedCount int            `json:"approved_count"`
	RatingSum     int            `json:"rating_sum"`
	AverageRating float64        `json:"average_rating"`
	RatingCounts  map[string]int `json:"rating_counts"`
	LastReviewAt  *time.Time     `json:"last_review_at,omitempty"`
}

type ValidationResult struct {
	Valid    bool     `json:"valid"`
	Errors   []string `json:"errors,omitempty"`
	Warnings []string `json:"warnings,omitempty"`
}

var ErrNotFound = errors.New("reviews: not found")

func MountRoutes(r chi.Router, d *Deps) {
	if d == nil || d.Repo == nil {
		return
	}
	read := apikeys.RequireScope(apikeys.ScopeReadReports)
	admin := apikeys.RequireScope(apikeys.ScopeAdmin)
	r.With(read).Get("/api/v1/reviews/catalog", d.Catalog)
	r.With(read).Get("/api/v1/reviews", d.ListReviews)
	r.With(admin).Post("/api/v1/reviews", d.CreateReview)
	r.With(read).Get("/api/v1/reviews/{id}", d.GetReview)
	r.With(admin).Patch("/api/v1/reviews/{id}", d.UpdateReview)
	r.With(admin).Post("/api/v1/reviews/{id}/approve", d.ApproveReview)
	r.With(admin).Post("/api/v1/reviews/{id}/reject", d.RejectReview)
	r.With(read).Get("/api/v1/reviews/products/{product_id}/summary", d.ProductSummary)
	r.With(admin).Post("/api/v1/reviews/{id}/media", d.CreateMedia)
	r.With(admin).Post("/api/v1/reviews/requests", d.CreateRequest)
	r.With(read).Get("/api/v1/reviews/questions", d.ListQuestions)
	r.With(admin).Post("/api/v1/reviews/questions", d.CreateQuestion)
	r.With(admin).Post("/api/v1/reviews/{id}/reply", d.CreateReply)
	r.With(read).Get("/api/v1/reviews/widgets", d.ListWidgets)
	r.With(admin).Post("/api/v1/reviews/widgets", d.CreateWidget)
	r.With(read).Get("/api/v1/reviews/widgets/{id}/embed/{flavor}", d.WidgetEmbed)
}

// MountPublicRoutes registers the storefront-facing review routes. The GET
// widget routes are unthrottled (they load on every storefront page view);
// submitMW (typically a public rate limiter) is applied ONLY to the
// unauthenticated POST submit, which fans out to flow enrollment and so must
// not be floodable.
func (d *Deps) MountPublicRoutes(r chi.Router, submitMW ...func(http.Handler) http.Handler) {
	if d == nil || d.Repo == nil {
		return
	}
	r.Get("/reviews.js", d.PublicWidgetScript)
	r.Get("/api/public/reviews/widgets/{slug}", d.PublicWidget)
	r.Get("/api/public/reviews/widgets/{slug}/html", d.PublicWidgetHTML)
	r.Get("/api/public/reviews/widgets/{slug}/embed.js", d.PublicWidgetScript)
	r.With(submitMW...).Post("/api/public/reviews/widgets/{slug}/submit", d.PublicSubmit)
}

func (d *Deps) Catalog(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, map[string]any{
		"schema_version":   "klv11.reviews.v1",
		"statuses":         []string{"pending", "approved", "rejected", "spam", "archived"},
		"widget_types":     []string{"star_rating", "summary", "product_reviews", "featured_carousel", "all_reviews", "qna"},
		"request_channels": []string{"email", "sms", "customer_hub", "api"},
		"authenticity":     []string{"verified_buyer", "incentivized", "featured", "public_reply"},
		"public_contract":  "Public widgets expose approved reviews only and redact reviewer email/raw moderation metadata.",
	})
}

func (d *Deps) ListReviews(w http.ResponseWriter, r *http.Request) {
	tenantID, ok := tenantID(r)
	if !ok {
		writeJSON(w, http.StatusUnauthorized, errEnv("no_tenant", "tenant required"))
		return
	}
	out, err := d.Repo.ListReviews(r.Context(), tenantID, r.URL.Query().Get("status"), r.URL.Query().Get("product_id"))
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), tenantID))
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"items": out})
}

func (d *Deps) CreateReview(w http.ResponseWriter, r *http.Request) {
	tenantID, ok := tenantID(r)
	if !ok {
		writeJSON(w, http.StatusUnauthorized, errEnv("no_tenant", "tenant required"))
		return
	}
	var in Review
	if err := httpbody.DecodeJSON(w, r, httpbody.DefaultJSONMaxBodyBytes, &in); err != nil {
		httpbody.WriteError(w, err)
		return

	}
	if validation := ValidateReview(in); !validation.Valid {
		writeJSON(w, http.StatusBadRequest, validation)
		return
	}
	out, err := d.Repo.CreateReview(r.Context(), tenantID, in)
	if err != nil {
		d.writeRepoError(w, r, err, "review_create_failed")
		return
	}
	d.emitReviewSubmitted(r.Context(), tenantID, out)
	writeJSON(w, http.StatusCreated, out)
}

func (d *Deps) GetReview(w http.ResponseWriter, r *http.Request) {
	tenantID, ok := tenantID(r)
	if !ok {
		writeJSON(w, http.StatusUnauthorized, errEnv("no_tenant", "tenant required"))
		return
	}
	out, err := d.Repo.GetReview(r.Context(), tenantID, chi.URLParam(r, "id"))
	if err != nil {
		d.writeRepoError(w, r, err, "review_failed")
		return
	}
	writeJSON(w, http.StatusOK, out)
}

func (d *Deps) UpdateReview(w http.ResponseWriter, r *http.Request) {
	tenantID, ok := tenantID(r)
	if !ok {
		writeJSON(w, http.StatusUnauthorized, errEnv("no_tenant", "tenant required"))
		return
	}
	var in Review
	if err := httpbody.DecodeJSON(w, r, httpbody.DefaultJSONMaxBodyBytes, &in); err != nil {
		httpbody.WriteError(w, err)
		return

	}
	if validation := ValidateReview(in); !validation.Valid {
		writeJSON(w, http.StatusBadRequest, validation)
		return
	}
	out, err := d.Repo.UpdateReview(r.Context(), tenantID, chi.URLParam(r, "id"), in)
	if err != nil {
		d.writeRepoError(w, r, err, "review_update_failed")
		return
	}
	writeJSON(w, http.StatusOK, out)
}

func (d *Deps) ApproveReview(w http.ResponseWriter, r *http.Request) {
	d.moderateReview(w, r, "approved")
}
func (d *Deps) RejectReview(w http.ResponseWriter, r *http.Request) {
	d.moderateReview(w, r, "rejected")
}

func (d *Deps) moderateReview(w http.ResponseWriter, r *http.Request, status string) {
	tenantID, ok := tenantID(r)
	if !ok {
		writeJSON(w, http.StatusUnauthorized, errEnv("no_tenant", "tenant required"))
		return
	}
	out, err := d.Repo.ModerateReview(r.Context(), tenantID, chi.URLParam(r, "id"), status)
	if err != nil {
		d.writeRepoError(w, r, err, "moderation_failed")
		return
	}
	writeJSON(w, http.StatusOK, out)
}

func (d *Deps) ProductSummary(w http.ResponseWriter, r *http.Request) {
	tenantID, ok := tenantID(r)
	if !ok {
		writeJSON(w, http.StatusUnauthorized, errEnv("no_tenant", "tenant required"))
		return
	}
	out, err := d.Repo.ProductSummary(r.Context(), tenantID, chi.URLParam(r, "product_id"))
	if err != nil {
		d.writeRepoError(w, r, err, "summary_failed")
		return
	}
	writeJSON(w, http.StatusOK, out)
}

func (d *Deps) CreateMedia(w http.ResponseWriter, r *http.Request) {
	tenantID, ok := tenantID(r)
	if !ok {
		writeJSON(w, http.StatusUnauthorized, errEnv("no_tenant", "tenant required"))
		return
	}
	var in Media
	if err := httpbody.DecodeJSON(w, r, httpbody.DefaultJSONMaxBodyBytes, &in); err != nil {
		httpbody.WriteError(w, err)
		return

	}
	in.ReviewID = chi.URLParam(r, "id")
	if validation := ValidateMedia(in); !validation.Valid {
		writeJSON(w, http.StatusBadRequest, validation)
		return
	}
	out, err := d.Repo.CreateMedia(r.Context(), tenantID, in)
	if err != nil {
		d.writeRepoError(w, r, err, "media_failed")
		return
	}
	d.hydrateMediaURL(r.Context(), tenantID, out)
	writeJSON(w, http.StatusCreated, out)
}

func (d *Deps) CreateRequest(w http.ResponseWriter, r *http.Request) {
	tenantID, ok := tenantID(r)
	if !ok {
		writeJSON(w, http.StatusUnauthorized, errEnv("no_tenant", "tenant required"))
		return
	}
	var in ReviewRequest
	if err := httpbody.DecodeJSON(w, r, httpbody.DefaultJSONMaxBodyBytes, &in); err != nil {
		httpbody.WriteError(w, err)
		return

	}
	out, err := d.Repo.CreateRequest(r.Context(), tenantID, in)
	if err != nil {
		d.writeRepoError(w, r, err, "request_failed")
		return
	}
	d.emitReviewRequested(r.Context(), tenantID, out)
	writeJSON(w, http.StatusCreated, out)
}

func (d *Deps) ListQuestions(w http.ResponseWriter, r *http.Request) {
	tenantID, ok := tenantID(r)
	if !ok {
		writeJSON(w, http.StatusUnauthorized, errEnv("no_tenant", "tenant required"))
		return
	}
	out, err := d.Repo.ListQuestions(r.Context(), tenantID, r.URL.Query().Get("product_id"))
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), tenantID))
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"items": out})
}

func (d *Deps) CreateQuestion(w http.ResponseWriter, r *http.Request) {
	tenantID, ok := tenantID(r)
	if !ok {
		writeJSON(w, http.StatusUnauthorized, errEnv("no_tenant", "tenant required"))
		return
	}
	var in Question
	if err := httpbody.DecodeJSON(w, r, httpbody.DefaultJSONMaxBodyBytes, &in); err != nil {
		httpbody.WriteError(w, err)
		return

	}
	if strings.TrimSpace(in.Question) == "" {
		writeJSON(w, http.StatusBadRequest, errEnv("question_invalid", "question is required"))
		return
	}
	out, err := d.Repo.CreateQuestion(r.Context(), tenantID, in)
	if err != nil {
		d.writeRepoError(w, r, err, "question_failed")
		return
	}
	writeJSON(w, http.StatusCreated, out)
}

func (d *Deps) CreateReply(w http.ResponseWriter, r *http.Request) {
	tenantID, ok := tenantID(r)
	if !ok {
		writeJSON(w, http.StatusUnauthorized, errEnv("no_tenant", "tenant required"))
		return
	}
	var in PublicReply
	if err := httpbody.DecodeJSON(w, r, httpbody.DefaultJSONMaxBodyBytes, &in); err != nil {
		httpbody.WriteError(w, err)
		return

	}
	in.ReviewID = chi.URLParam(r, "id")
	if strings.TrimSpace(in.Body) == "" {
		writeJSON(w, http.StatusBadRequest, errEnv("reply_invalid", "body is required"))
		return
	}
	out, err := d.Repo.CreateReply(r.Context(), tenantID, in)
	if err != nil {
		d.writeRepoError(w, r, err, "reply_failed")
		return
	}
	writeJSON(w, http.StatusCreated, out)
}

func (d *Deps) ListWidgets(w http.ResponseWriter, r *http.Request) {
	tenantID, ok := tenantID(r)
	if !ok {
		writeJSON(w, http.StatusUnauthorized, errEnv("no_tenant", "tenant required"))
		return
	}
	out, err := d.Repo.ListWidgets(r.Context(), tenantID)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), tenantID))
		return
	}
	for i := range out {
		out[i].PublicURL = d.publicWidgetURL(r, out[i].Slug)
	}
	writeJSON(w, http.StatusOK, map[string]any{"items": out})
}

func (d *Deps) CreateWidget(w http.ResponseWriter, r *http.Request) {
	tenantID, ok := tenantID(r)
	if !ok {
		writeJSON(w, http.StatusUnauthorized, errEnv("no_tenant", "tenant required"))
		return
	}
	var in Widget
	if err := httpbody.DecodeJSON(w, r, httpbody.DefaultJSONMaxBodyBytes, &in); err != nil {
		httpbody.WriteError(w, err)
		return

	}
	if validation := ValidateWidget(in); !validation.Valid {
		writeJSON(w, http.StatusBadRequest, validation)
		return
	}
	out, err := d.Repo.CreateWidget(r.Context(), tenantID, in)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), tenantID))
		return
	}
	out.PublicURL = d.publicWidgetURL(r, out.Slug)
	writeJSON(w, http.StatusCreated, out)
}

func (d *Deps) WidgetEmbed(w http.ResponseWriter, r *http.Request) {
	tenantID, ok := tenantID(r)
	if !ok {
		writeJSON(w, http.StatusUnauthorized, errEnv("no_tenant", "tenant required"))
		return
	}
	widget, err := d.Repo.GetWidget(r.Context(), tenantID, chi.URLParam(r, "id"))
	if err != nil {
		d.writeRepoError(w, r, err, "widget_failed")
		return
	}
	flavor := strings.ToLower(chi.URLParam(r, "flavor"))
	base := strings.TrimRight(d.PublicBase, "/")
	if base == "" {
		base = publicBaseGuess(r)
	}
	src := fmt.Sprintf("%s/api/public/reviews/widgets/%s", base, widget.Slug)
	snippet := fmt.Sprintf(`<iframe src="%s" data-postwave-reviews="%s" loading="lazy"></iframe>`, src, widget.Slug)
	if flavor == "script" {
		snippet = fmt.Sprintf(`<script async src="%s/api/public/reviews/widgets/%s/embed.js" data-postwave-reviews="%s"></script>`, base, widget.Slug, widget.Slug)
	}
	writeJSON(w, http.StatusOK, map[string]any{"flavor": flavor, "snippet": snippet})
}

func (d *Deps) PublicWidget(w http.ResponseWriter, r *http.Request) {
	payload, err := d.publicWidgetPayload(r)
	if err != nil {
		d.writeRepoError(w, r, err, "widget_failed")
		return
	}
	writeJSON(w, http.StatusOK, payload)
}

func (d *Deps) PublicWidgetHTML(w http.ResponseWriter, r *http.Request) {
	payload, err := d.publicWidgetPayload(r)
	if err != nil {
		d.writeRepoError(w, r, err, "widget_failed")
		return
	}
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.Header().Set("Cache-Control", "public, max-age=300")
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write([]byte(renderWidgetMarkup(payload)))
}

func (d *Deps) PublicWidgetScript(w http.ResponseWriter, r *http.Request) {
	slug := chi.URLParam(r, "slug")
	w.Header().Set("Content-Type", "application/javascript; charset=utf-8")
	w.Header().Set("Cache-Control", "public, max-age=300")
	w.WriteHeader(http.StatusOK)
	script := strings.Replace(publicWidgetScript, "__POSTWAVE_DEFAULT_SLUG__", jsonString(slug), 1)
	_, _ = w.Write([]byte(script))
}

func (d *Deps) PublicSubmit(w http.ResponseWriter, r *http.Request) {
	slug := chi.URLParam(r, "slug")
	widget, err := d.Repo.GetWidgetBySlugPublic(r.Context(), slug)
	if err != nil {
		d.writeRepoError(w, r, err, "widget_failed")
		return
	}
	var in Review
	if err := httpbody.DecodeJSON(w, r, httpbody.DefaultJSONMaxBodyBytes, &in); err != nil {
		httpbody.WriteError(w, err)
		return

	}
	in.Status = "pending"
	if validation := ValidateReview(in); !validation.Valid {
		writeJSON(w, http.StatusBadRequest, validation)
		return
	}
	out, err := d.Repo.CreateReview(r.Context(), widget.TenantID, in)
	if err != nil {
		d.writeRepoError(w, r, err, "review_submit_failed")
		return
	}
	d.emitReviewSubmitted(r.Context(), widget.TenantID, out)
	writeJSON(w, http.StatusCreated, map[string]any{"review": ToPublicReview(out), "status": "pending_moderation"})
}

type publicWidgetPayload struct {
	Widget  map[string]any `json:"widget"`
	Summary *Summary       `json:"summary"`
	Reviews []PublicReview `json:"reviews"`
}

func (d *Deps) publicWidgetPayload(r *http.Request) (publicWidgetPayload, error) {
	slug := chi.URLParam(r, "slug")
	widget, err := d.Repo.GetWidgetBySlugPublic(r.Context(), slug)
	if err != nil {
		return publicWidgetPayload{}, err
	}
	productID := r.URL.Query().Get("product_id")
	reviews, summary, err := d.Repo.PublicWidgetData(r.Context(), widget.TenantID, productID)
	if err != nil {
		return publicWidgetPayload{}, err
	}
	return publicWidgetPayload{
		Widget:  ToPublicWidget(widget),
		Summary: summary,
		Reviews: reviews,
	}, nil
}

func ValidateReview(in Review) ValidationResult {
	normalizeReview(&in)
	out := ValidationResult{Valid: true}
	if in.Rating < 1 || in.Rating > 5 {
		out.Errors = append(out.Errors, "rating must be between 1 and 5")
	}
	if !allowed(in.Status, []string{"pending", "approved", "rejected", "spam", "archived"}) {
		out.Errors = append(out.Errors, "status is invalid")
	}
	if !allowed(in.ReviewType, []string{"product", "store", "question_answer"}) {
		out.Errors = append(out.Errors, "review_type is invalid")
	}
	if strings.TrimSpace(in.Body) == "" && strings.TrimSpace(in.Title) == "" {
		out.Errors = append(out.Errors, "title or body is required")
	}
	out.Valid = len(out.Errors) == 0
	return out
}

func ValidateWidget(in Widget) ValidationResult {
	normalizeWidget(&in)
	out := ValidationResult{Valid: true}
	if strings.TrimSpace(in.Name) == "" {
		out.Errors = append(out.Errors, "name is required")
	}
	if !allowed(in.Status, []string{"draft", "active", "paused", "archived"}) {
		out.Errors = append(out.Errors, "status is invalid")
	}
	if !allowed(in.WidgetType, []string{"star_rating", "summary", "product_reviews", "featured_carousel", "all_reviews", "qna"}) {
		out.Errors = append(out.Errors, "widget_type is invalid")
	}
	out.Valid = len(out.Errors) == 0
	return out
}

func ValidateMedia(in Media) ValidationResult {
	normalizeMedia(&in)
	out := ValidationResult{Valid: true}
	if strings.TrimSpace(in.StorageKey) == "" {
		out.Errors = append(out.Errors, "storage_key is required")
	}
	if strings.Contains(in.StorageKey, "..") || strings.HasPrefix(in.StorageKey, "/") {
		out.Errors = append(out.Errors, "storage_key is unsafe")
	}
	if in.SizeBytes < 0 {
		out.Errors = append(out.Errors, "size_bytes must be non-negative")
	}
	if !allowed(in.Status, []string{"pending", "uploaded", "approved", "rejected", "deleted"}) {
		out.Errors = append(out.Errors, "status is invalid")
	}
	out.Valid = len(out.Errors) == 0
	return out
}

func SummaryFromReviews(productID string, reviews []Review) Summary {
	out := Summary{ProductID: productID, RatingCounts: map[string]int{"1": 0, "2": 0, "3": 0, "4": 0, "5": 0}}
	for _, review := range reviews {
		if review.Status != "approved" {
			continue
		}
		out.ApprovedCount++
		out.RatingSum += review.Rating
		key := fmt.Sprintf("%d", review.Rating)
		out.RatingCounts[key]++
		if out.LastReviewAt == nil || (review.PublishedAt != nil && review.PublishedAt.After(*out.LastReviewAt)) {
			out.LastReviewAt = review.PublishedAt
		}
	}
	if out.ApprovedCount > 0 {
		out.AverageRating = float64(out.RatingSum) / float64(out.ApprovedCount)
	}
	return out
}

func ToPublicReview(in *Review) PublicReview {
	if in == nil {
		return PublicReview{}
	}
	name := strings.TrimSpace(in.ReviewerName)
	if name == "" {
		name = "Verified customer"
	}
	return PublicReview{
		ID:            in.ID,
		ProductID:     in.ProductID,
		Rating:        in.Rating,
		Title:         in.Title,
		Body:          in.Body,
		ReviewerName:  name,
		VerifiedBuyer: in.VerifiedBuyer,
		Incentivized:  in.Incentivized,
		Featured:      in.Featured,
		PublishedAt:   in.PublishedAt,
		PublicReplies: in.PublicReplies,
	}
}

func ToPublicWidget(in *Widget) map[string]any {
	return map[string]any{
		"slug":             in.Slug,
		"name":             in.Name,
		"widget_type":      in.WidgetType,
		"display_settings": in.DisplaySettings,
		"language":         in.Language,
		"styling":          in.Styling,
	}
}

func renderWidgetMarkup(payload publicWidgetPayload) string {
	name := stringMapValue(payload.Widget, "name", "Reviews")
	var b strings.Builder
	b.WriteString(`<section class="postwave-reviews" data-postwave-reviews-rendered="true">`)
	b.WriteString(`<style>.postwave-reviews{font-family:system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:#1f2937}.postwave-reviews__header{display:flex;align-items:baseline;justify-content:space-between;gap:12px;margin-bottom:14px}.postwave-reviews__title{font-size:18px;font-weight:700;margin:0}.postwave-reviews__score{font-size:14px;color:#4b5563}.postwave-reviews__list{display:grid;gap:10px}.postwave-reviews__item{border:1px solid #e5e7eb;border-radius:8px;padding:12px;background:#fff}.postwave-reviews__meta{display:flex;gap:8px;align-items:center;font-size:13px;color:#4b5563}.postwave-reviews__rating{font-weight:700;color:#111827}.postwave-reviews__review-title{font-size:15px;font-weight:700;margin:8px 0 4px}.postwave-reviews__body{font-size:14px;line-height:1.45;margin:0;color:#374151}.postwave-reviews__badge{font-size:11px;border:1px solid #d1d5db;border-radius:999px;padding:1px 6px;color:#374151}.postwave-reviews__empty{font-size:14px;color:#6b7280}</style>`)
	b.WriteString(`<div class="postwave-reviews__header"><h3 class="postwave-reviews__title">`)
	b.WriteString(html.EscapeString(name))
	b.WriteString(`</h3>`)
	if payload.Summary != nil && payload.Summary.ApprovedCount > 0 {
		b.WriteString(`<div class="postwave-reviews__score">`)
		b.WriteString(fmt.Sprintf("%.1f/5 from %d reviews", payload.Summary.AverageRating, payload.Summary.ApprovedCount))
		b.WriteString(`</div>`)
	}
	b.WriteString(`</div><div class="postwave-reviews__list">`)
	if len(payload.Reviews) == 0 {
		b.WriteString(`<p class="postwave-reviews__empty">No reviews yet.</p>`)
	} else {
		for _, review := range payload.Reviews {
			b.WriteString(`<article class="postwave-reviews__item"><div class="postwave-reviews__meta"><span class="postwave-reviews__rating">`)
			b.WriteString(fmt.Sprintf("%d/5", review.Rating))
			b.WriteString(`</span><span>`)
			b.WriteString(html.EscapeString(review.ReviewerName))
			b.WriteString(`</span>`)
			if review.VerifiedBuyer {
				b.WriteString(`<span class="postwave-reviews__badge">Verified</span>`)
			}
			if review.Incentivized {
				b.WriteString(`<span class="postwave-reviews__badge">Incentivized</span>`)
			}
			b.WriteString(`</div>`)
			if strings.TrimSpace(review.Title) != "" {
				b.WriteString(`<h4 class="postwave-reviews__review-title">`)
				b.WriteString(html.EscapeString(review.Title))
				b.WriteString(`</h4>`)
			}
			if strings.TrimSpace(review.Body) != "" {
				b.WriteString(`<p class="postwave-reviews__body">`)
				b.WriteString(html.EscapeString(review.Body))
				b.WriteString(`</p>`)
			}
			for _, reply := range review.PublicReplies {
				b.WriteString(`<p class="postwave-reviews__body"><strong>`)
				b.WriteString(html.EscapeString(reply.Author))
				b.WriteString(`:</strong> `)
				b.WriteString(html.EscapeString(reply.Body))
				b.WriteString(`</p>`)
			}
			b.WriteString(`</article>`)
		}
	}
	b.WriteString(`</div></section>`)
	return b.String()
}

func stringMapValue(in map[string]any, key, fallback string) string {
	if in == nil {
		return fallback
	}
	if value, ok := in[key].(string); ok && strings.TrimSpace(value) != "" {
		return value
	}
	return fallback
}

func jsonString(value string) string {
	raw, _ := json.Marshal(value)
	return string(raw)
}

const publicWidgetScript = `(function(){
  var defaultSlug = __POSTWAVE_DEFAULT_SLUG__;
  var script = document.currentScript;
  if (!script) {
    var scripts = document.getElementsByTagName("script");
    script = scripts[scripts.length - 1];
  }
  function escapeHTML(value) {
    return String(value == null ? "" : value).replace(/[&<>"']/g, function(ch) {
      return {"&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#39;"}[ch];
    });
  }
  function slugFromPath(url) {
    var parts = url.pathname.split("/");
    var idx = parts.indexOf("widgets");
    if (idx >= 0 && parts[idx + 1]) return decodeURIComponent(parts[idx + 1]);
    return "";
  }
  function basePath(url) {
    var marker = "/api/public/reviews/";
    var idx = url.pathname.indexOf(marker);
    return idx >= 0 ? url.pathname.slice(0, idx) : "";
  }
  function ensureStyle() {
    if (document.getElementById("postwave-reviews-style")) return;
    var style = document.createElement("style");
    style.id = "postwave-reviews-style";
    style.textContent = ".postwave-reviews{font-family:system-ui,-apple-system,BlinkMacSystemFont,\"Segoe UI\",sans-serif;color:#1f2937}.postwave-reviews__header{display:flex;align-items:baseline;justify-content:space-between;gap:12px;margin-bottom:14px}.postwave-reviews__title{font-size:18px;font-weight:700;margin:0}.postwave-reviews__score{font-size:14px;color:#4b5563}.postwave-reviews__list{display:grid;gap:10px}.postwave-reviews__item{border:1px solid #e5e7eb;border-radius:8px;padding:12px;background:#fff}.postwave-reviews__meta{display:flex;gap:8px;align-items:center;font-size:13px;color:#4b5563}.postwave-reviews__rating{font-weight:700;color:#111827}.postwave-reviews__review-title{font-size:15px;font-weight:700;margin:8px 0 4px}.postwave-reviews__body{font-size:14px;line-height:1.45;margin:0;color:#374151}.postwave-reviews__badge{font-size:11px;border:1px solid #d1d5db;border-radius:999px;padding:1px 6px;color:#374151}.postwave-reviews__empty{font-size:14px;color:#6b7280}";
    document.head.appendChild(style);
  }
  function render(target, data) {
    ensureStyle();
    var summary = data.summary || {};
    var widget = data.widget || {};
    var reviews = data.reviews || [];
    var html = '<section class="postwave-reviews" data-postwave-reviews-rendered="true">';
    html += '<div class="postwave-reviews__header"><h3 class="postwave-reviews__title">' + escapeHTML(widget.name || "Reviews") + '</h3>';
    if (summary.approved_count > 0) {
      html += '<div class="postwave-reviews__score">' + Number(summary.average_rating || 0).toFixed(1) + '/5 from ' + Number(summary.approved_count || 0) + ' reviews</div>';
    }
    html += '</div><div class="postwave-reviews__list">';
    if (!reviews.length) {
      html += '<p class="postwave-reviews__empty">No reviews yet.</p>';
    } else {
      reviews.forEach(function(review) {
        html += '<article class="postwave-reviews__item"><div class="postwave-reviews__meta">';
        html += '<span class="postwave-reviews__rating">' + Number(review.rating || 0) + '/5</span>';
        html += '<span>' + escapeHTML(review.reviewer_name || "Verified customer") + '</span>';
        if (review.verified_buyer) html += '<span class="postwave-reviews__badge">Verified</span>';
        if (review.incentivized) html += '<span class="postwave-reviews__badge">Incentivized</span>';
        html += '</div>';
        if (review.title) html += '<h4 class="postwave-reviews__review-title">' + escapeHTML(review.title) + '</h4>';
        if (review.body) html += '<p class="postwave-reviews__body">' + escapeHTML(review.body) + '</p>';
        (review.public_replies || []).forEach(function(reply) {
          html += '<p class="postwave-reviews__body"><strong>' + escapeHTML(reply.author || "Store owner") + ':</strong> ' + escapeHTML(reply.body || "") + '</p>';
        });
        html += '</article>';
      });
    }
    html += '</div></section>';
    target.innerHTML = html;
  }
  if (!script) return;
  var src = new URL(script.src || window.location.href, window.location.href);
  var slug = script.getAttribute("data-postwave-reviews") || defaultSlug || slugFromPath(src);
  if (!slug) return;
  var selector = script.getAttribute("data-postwave-target");
  var target = selector ? document.querySelector(selector) : null;
  if (!target) {
    target = document.createElement("div");
    target.setAttribute("data-postwave-reviews-root", slug);
    script.parentNode.insertBefore(target, script.nextSibling);
  }
  var productID = script.getAttribute("data-product-id") || target.getAttribute("data-product-id") || "";
  var endpoint = src.origin + basePath(src) + "/api/public/reviews/widgets/" + encodeURIComponent(slug);
  if (productID) endpoint += "?product_id=" + encodeURIComponent(productID);
  fetch(endpoint, {credentials:"omit"}).then(function(res) {
    if (!res.ok) throw new Error("reviews widget failed");
    return res.json();
  }).then(function(data) {
    render(target, data);
  }).catch(function() {
    target.innerHTML = '<section class="postwave-reviews"><p class="postwave-reviews__empty">Reviews are unavailable.</p></section>';
  });
})();`

func normalizeReview(in *Review) {
	in.SourcePlatform = defaulted(strings.TrimSpace(in.SourcePlatform), "postwave")
	in.ReviewType = defaulted(strings.TrimSpace(in.ReviewType), "product")
	in.Status = defaulted(strings.TrimSpace(in.Status), "pending")
	in.ReviewerEmail = strings.TrimSpace(strings.ToLower(in.ReviewerEmail))
	in.CustomerID = strings.TrimSpace(in.CustomerID)
	if in.Metadata == nil {
		in.Metadata = map[string]any{}
	}
	if in.RawPayload == nil {
		in.RawPayload = map[string]any{}
	}
}

func normalizeWidget(in *Widget) {
	in.Name = strings.TrimSpace(in.Name)
	if in.Slug == "" {
		in.Slug = slugify(in.Name)
	}
	in.Slug = strings.Trim(strings.ToLower(strings.TrimSpace(in.Slug)), "-")
	in.Status = defaulted(strings.TrimSpace(in.Status), "draft")
	in.WidgetType = defaulted(strings.TrimSpace(in.WidgetType), "product_reviews")
	in.Language = defaulted(strings.TrimSpace(in.Language), "en")
	if in.ProductFilter == nil {
		in.ProductFilter = map[string]any{}
	}
	if in.DisplaySettings == nil {
		in.DisplaySettings = map[string]any{}
	}
	if in.ModerationSettings == nil {
		in.ModerationSettings = map[string]any{}
	}
	if in.Styling == nil {
		in.Styling = map[string]any{}
	}
	if in.Metadata == nil {
		in.Metadata = map[string]any{}
	}
}

func normalizeMedia(in *Media) {
	in.Status = defaulted(strings.TrimSpace(in.Status), "pending")
	if in.Metadata == nil {
		in.Metadata = map[string]any{}
	}
}

func (d *Deps) hydrateMediaURL(ctx context.Context, tenantID string, in *Media) {
	if d == nil || d.Storage == nil || in == nil || in.StorageKey == "" {
		return
	}
	if url, err := d.Storage.PresignGet(ctx, tenantID, in.StorageKey, time.Hour); err == nil {
		in.PresignedURL = url
	}
}

func (d *Deps) publicWidgetURL(r *http.Request, slug string) string {
	base := strings.TrimRight(d.PublicBase, "/")
	if base == "" {
		base = publicBaseGuess(r)
	}
	return base + "/api/public/reviews/widgets/" + slug
}

func tenantID(r *http.Request) (string, bool) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok || t.ID == "" {
		return "", false
	}
	return t.ID, true
}

func (d *Deps) writeRepoError(w http.ResponseWriter, r *http.Request, err error, code string) {
	_ = code
	if errors.Is(err, ErrNotFound) {
		writeJSON(w, http.StatusNotFound, errEnv("not_found", "resource not found"))
		return
	}
	ctx := r.Context()
	if tid, ok := tenantID(r); ok {
		ctx = httperror.WithTenantIDLog(ctx, tid)
	}
	httperror.WriteInternal(w, d.Logger, err, ctx)
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

func errEnv(code, message string) map[string]any {
	return map[string]any{"error": map[string]string{"code": code, "message": message}}
}

func slugify(s string) string {
	s = strings.ToLower(strings.TrimSpace(s))
	var b strings.Builder
	lastDash := false
	for _, r := range s {
		ok := (r >= 'a' && r <= 'z') || (r >= '0' && r <= '9')
		if ok {
			b.WriteRune(r)
			lastDash = false
			continue
		}
		if !lastDash {
			b.WriteByte('-')
			lastDash = true
		}
	}
	out := strings.Trim(b.String(), "-")
	if out == "" {
		return "reviews"
	}
	return out
}

func publicBaseGuess(r *http.Request) string {
	scheme := "https"
	if r.TLS == nil {
		scheme = "http"
	}
	return scheme + "://" + r.Host
}

func allowed(v string, allowed []string) bool {
	for _, a := range allowed {
		if v == a {
			return true
		}
	}
	return false
}

func defaulted(v, fallback string) string {
	if strings.TrimSpace(v) == "" {
		return fallback
	}
	return v
}
