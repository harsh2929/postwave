// SPDX-License-Identifier: AGPL-3.0-only
//
// Package campaign_replies implements G3 of the campaigns 2026 pack —
// reply-loop tooling backbone.
//
// Moosewave already ingests inbound mail and links it to campaigns via
// inbound_emails.campaign_id (set when the inbound message_id's
// In-Reply-To matches an outgoing campaign's Message-ID). Operators
// never see those replies threaded against the campaign though — the
// existing surface is the inbound-route admin, which is conversation-
// shaped not campaign-shaped.
//
// v1 backbone: a tenant-scoped read endpoint that surfaces the
// replies-for-a-campaign list, plus the wiring so a desktop Replies
// section in CampaignDetailSlideover can render them next to the
// existing Feedback + Activity panels.
//
// The reply-intent classifier (question / praise / unsub / OOO) ships
// here: classify (on-demand) returns + persists an LLM intent with a
// heuristic short-circuit. Endpoints: list (with ?intent= filter),
// get (single reply), classify. The "Quote a reader reply" editor
// block is wired on the desktop side (ReplyQuotePicker +
// DynamicContentPanel).
package campaign_replies

import (
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"strconv"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/postwave/postwave/apps/api/internal/apikeys"
	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/httperror"
	"github.com/postwave/postwave/apps/api/internal/middleware"
)

var (
	errReplyNotFound        = errors.New("campaign_replies: reply not found")
	errReplyBodyUnavailable = errors.New("campaign_replies: reply body evidence has been redacted")
)

// Reply is one inbound message that landed in reply to a campaign send.
type Reply struct {
	ID                   string     `json:"id"`
	FromEmail            string     `json:"from_email"`
	Subject              string     `json:"subject"`
	BodyText             string     `json:"body_text"`
	ReceivedAt           time.Time  `json:"received_at"`
	Classification       string     `json:"classification,omitempty"`
	Source               string     `json:"source,omitempty"`
	BodyRedacted         bool       `json:"body_redacted"`
	IntentLabel          string     `json:"intent_label,omitempty"`
	IntentConfidence     float64    `json:"intent_confidence,omitempty"`
	IntentClassifiedAt   *time.Time `json:"intent_classified_at,omitempty"`
	IntentClassifierName string     `json:"intent_classifier,omitempty"`
	IntentRevision       int        `json:"intent_revision,omitempty"`
}

// Listing wraps the response. Count and intent counts cover the entire
// campaign/filter, not merely the bounded page of returned replies.
type Listing struct {
	CampaignID   string         `json:"campaign_id"`
	Count        int            `json:"count"`
	IntentCounts map[string]int `json:"intent_counts"`
	Replies      []Reply        `json:"replies"`
}

// Deps bundles the pool.
type Deps struct {
	Pool             *db.Pool
	IntentClassifier IntentClassifier
	Logger           *slog.Logger
}

const campaignReplySelect = `
SELECT reply.id::text,
       reply.recipient_email::text,
       COALESCE(reply.subject, ''),
       CASE WHEN reply.body_redacted_at IS NULL
            THEN COALESCE(reply.body_stripped, reply.body_snippet, '')
            ELSE '' END,
       reply.received_at,
       COALESCE(reply.classification, ''),
       reply.source,
       reply.body_redacted_at IS NOT NULL,
       COALESCE(intent.intent_class, ''),
       COALESCE(intent.intent_confidence, 0)::float8,
       intent.classified_at,
       COALESCE(intent.classifier, ''),
       COALESCE(intent.revision, 0)
  FROM campaign_replies reply
  LEFT JOIN campaign_reply_intents_current_v intent
    ON intent.tenant_id = reply.tenant_id
   AND intent.campaign_reply_id = reply.id`

func campaignReplyScanTargets(rep *Reply) []any {
	return []any{
		&rep.ID,
		&rep.FromEmail,
		&rep.Subject,
		&rep.BodyText,
		&rep.ReceivedAt,
		&rep.Classification,
		&rep.Source,
		&rep.BodyRedacted,
		&rep.IntentLabel,
		&rep.IntentConfidence,
		&rep.IntentClassifiedAt,
		&rep.IntentClassifierName,
		&rep.IntentRevision,
	}
}

// MountRoutes wires the read endpoint. Read uses read:reports —
// matches the rest of the per-campaign /report surface.
func MountRoutes(r chi.Router, d *Deps) {
	if d == nil || d.Pool == nil {
		return
	}
	r.With(apikeys.RequireScope(apikeys.ScopeReadReports)).
		Get("/api/v1/campaigns/{id}/replies", d.list)
	r.With(apikeys.RequireScope(apikeys.ScopeReadReports)).
		Get("/api/v1/campaigns/{id}/replies/{replyID}", d.get)
	r.With(apikeys.RequireScope(apikeys.ScopeWriteCampaigns)).
		Post("/api/v1/campaigns/{id}/replies/{replyID}/classify", d.classify)
}

// get returns a single reply (with its intent classification, if any) so
// the desktop can open a full reply in a thread/view modal without
// re-listing. Mirrors the list row shape.
func (d *Deps) get(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeErr(w, http.StatusUnauthorized, "no_tenant", "tenant required")
		return
	}
	if !requireReplyAdmin(w, r, t.ID) {
		return
	}
	campaignID := chi.URLParam(r, "id")
	replyID := chi.URLParam(r, "replyID")
	if _, err := uuid.Parse(campaignID); err != nil {
		writeErr(w, http.StatusBadRequest, "invalid_campaign_id", "campaign id must be a UUID")
		return
	}
	if _, err := uuid.Parse(replyID); err != nil {
		writeErr(w, http.StatusBadRequest, "invalid_reply_id", "reply id must be a UUID")
		return
	}
	tx, err := db.WithTenant(r.Context(), d.Pool, t.ID)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	defer func() { _ = tx.Rollback(r.Context()) }()
	var rep Reply
	err = tx.QueryRow(r.Context(), campaignReplySelect+`
 WHERE reply.campaign_id = $1::uuid AND reply.id = $2::uuid`,
		campaignID, replyID,
	).Scan(campaignReplyScanTargets(&rep)...)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			writeErr(w, http.StatusNotFound, "not_found", "reply not found")
			return
		}
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	writeJSON(w, http.StatusOK, rep)
}

const defaultLimit = 50
const maxLimit = 200

func (d *Deps) list(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeErr(w, http.StatusUnauthorized, "no_tenant", "tenant required")
		return
	}
	if !requireReplyAdmin(w, r, t.ID) {
		return
	}
	campaignID := chi.URLParam(r, "id")
	if _, err := uuid.Parse(campaignID); err != nil {
		writeErr(w, http.StatusBadRequest, "invalid_campaign_id", "campaign id must be a UUID")
		return
	}
	intent := r.URL.Query().Get("intent")
	if intent != "" && normalizeIntent(intent) == "" {
		writeErr(w, http.StatusBadRequest, "invalid_intent", "intent must be question, praise, unsub, ooo, or other")
		return
	}
	intent = normalizeIntent(intent)
	limit := defaultLimit
	if raw := r.URL.Query().Get("limit"); raw != "" {
		if v, err := strconv.Atoi(raw); err == nil && v > 0 {
			limit = v
		}
	}
	if limit > maxLimit {
		limit = maxLimit
	}

	tx, err := db.WithTenant(r.Context(), d.Pool, t.ID)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	defer func() { _ = tx.Rollback(r.Context()) }()

	out := Listing{
		CampaignID:   campaignID,
		IntentCounts: map[string]int{},
		Replies:      []Reply{},
	}

	args := []any{campaignID, limit}
	predicate := ""
	if intent != "" {
		predicate = " AND intent.intent_class = $3"
		args = append(args, intent)
	}
	rows, err := tx.Query(r.Context(), campaignReplySelect+`
 WHERE reply.campaign_id = $1::uuid`+predicate+`
 ORDER BY reply.received_at DESC, reply.id DESC
 LIMIT $2`, args...)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	for rows.Next() {
		var rep Reply
		if err := rows.Scan(campaignReplyScanTargets(&rep)...); err != nil {
			rows.Close()
			httperror.WriteInternal(w, d.Logger, err, r.Context())
			return
		}
		out.Replies = append(out.Replies, rep)
	}
	if err := rows.Err(); err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	rows.Close()
	countRows, err := tx.Query(r.Context(), `
SELECT COALESCE(intent.intent_class, ''), count(*)::int
  FROM campaign_replies reply
  LEFT JOIN campaign_reply_intents_current_v intent
    ON intent.tenant_id = reply.tenant_id
   AND intent.campaign_reply_id = reply.id
 WHERE reply.tenant_id = $1::uuid AND reply.campaign_id = $2::uuid
 GROUP BY COALESCE(intent.intent_class, '')`, t.ID, campaignID)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	for countRows.Next() {
		var label string
		var count int
		if err := countRows.Scan(&label, &count); err != nil {
			countRows.Close()
			httperror.WriteInternal(w, d.Logger, err, r.Context())
			return
		}
		if label != "" {
			out.IntentCounts[label] = count
		}
		if intent == "" || intent == label {
			out.Count += count
		}
	}
	if err := countRows.Err(); err != nil {
		countRows.Close()
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	countRows.Close()

	writeJSON(w, http.StatusOK, out)
}

func (d *Deps) classify(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeErr(w, http.StatusUnauthorized, "no_tenant", "tenant required")
		return
	}
	if !requireReplyAdmin(w, r, t.ID) {
		return
	}
	if d.IntentClassifier == nil {
		writeErr(w, http.StatusServiceUnavailable, "classifier_unavailable", "reply intent classifier is not configured")
		return
	}
	campaignID := chi.URLParam(r, "id")
	replyID := chi.URLParam(r, "replyID")
	rep, err := d.loadReply(r, t.ID, campaignID, replyID)
	if err != nil {
		if errors.Is(err, errReplyNotFound) {
			writeErr(w, http.StatusNotFound, "not_found", "reply not found")
			return
		}
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	if rep.BodyRedacted {
		writeErr(w, http.StatusConflict, "reply_body_redacted", "reply body evidence has been redacted and cannot be reclassified")
		return
	}
	intent, err := d.IntentClassifier.ClassifyReply(r.Context(), t.ID, rep.Subject, rep.BodyText)
	if err != nil {
		if errors.Is(err, ErrClassifierUnavailable) {
			writeErr(w, http.StatusServiceUnavailable, "classifier_unavailable", "reply intent classifier is unavailable")
			return
		}
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	rep, err = d.saveIntent(r, t.ID, campaignID, replyID, intent)
	if err != nil {
		if errors.Is(err, errReplyBodyUnavailable) {
			writeErr(w, http.StatusConflict, "reply_body_redacted", "reply body evidence has been redacted and cannot be reclassified")
			return
		}
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	writeJSON(w, http.StatusOK, rep)
}

// Replies are private correspondence. Route scopes alone allow editors and
// some tenant API keys, so enforce the same owner/admin boundary as the UI at
// the data boundary, including View-as-Viewer sessions.
func requireReplyAdmin(w http.ResponseWriter, r *http.Request, tenantID string) bool {
	u, ok := middleware.UserFromContext(r.Context())
	if !ok || u.TenantID != tenantID {
		writeErr(w, http.StatusForbidden, "reply_admin_required", "a workspace owner or admin session is required")
		return false
	}
	switch u.EffectiveRoleOrDurable() {
	case "owner", "admin":
		return true
	default:
		writeErr(w, http.StatusForbidden, "reply_admin_required", "a workspace owner or admin session is required")
		return false
	}
}

func (d *Deps) loadReply(r *http.Request, tenantID, campaignID, replyID string) (Reply, error) {
	if _, err := uuid.Parse(campaignID); err != nil {
		return Reply{}, errReplyNotFound
	}
	if _, err := uuid.Parse(replyID); err != nil {
		return Reply{}, errReplyNotFound
	}
	tx, err := db.WithTenant(r.Context(), d.Pool, tenantID)
	if err != nil {
		return Reply{}, err
	}
	defer func() { _ = tx.Rollback(r.Context()) }()
	var rep Reply
	err = tx.QueryRow(r.Context(), campaignReplySelect+`
 WHERE reply.campaign_id = $1::uuid AND reply.id = $2::uuid`,
		campaignID, replyID).Scan(campaignReplyScanTargets(&rep)...)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return Reply{}, errReplyNotFound
		}
		return Reply{}, err
	}
	return rep, tx.Commit(r.Context())
}

func (d *Deps) saveIntent(r *http.Request, tenantID, campaignID, replyID string, intent IntentResult) (Reply, error) {
	tx, err := db.WithTenant(r.Context(), d.Pool, tenantID)
	if err != nil {
		return Reply{}, err
	}
	defer func() { _ = tx.Rollback(r.Context()) }()
	var bodyHash string
	var bodyRedacted bool
	err = tx.QueryRow(r.Context(), `
SELECT body_evidence_sha256, body_redacted_at IS NOT NULL
  FROM campaign_replies
 WHERE tenant_id = $1::uuid
   AND campaign_id = $2::uuid
   AND id = $3::uuid`, tenantID, campaignID, replyID).Scan(&bodyHash, &bodyRedacted)
	if errors.Is(err, pgx.ErrNoRows) {
		return Reply{}, errReplyNotFound
	}
	if err != nil {
		return Reply{}, err
	}
	if bodyRedacted {
		return Reply{}, errReplyBodyUnavailable
	}
	classifier := normalizeIntentClassifier(intent.Classifier)
	classifierVersion := normalizeIntentClassifierVersion(classifier)
	if _, err = tx.Exec(r.Context(), `
INSERT INTO campaign_reply_intent_classifications (
    tenant_id,
    campaign_reply_id,
    intent_class,
    intent_confidence,
    classifier,
    classifier_version
)
VALUES (
    $1::uuid, $2::uuid, $3, $4, $5, $6
)`, tenantID, replyID, intent.Label, intent.Confidence, classifier,
		classifierVersion); err != nil {
		return Reply{}, err
	}
	var rep Reply
	err = tx.QueryRow(r.Context(), campaignReplySelect+`
 WHERE reply.tenant_id = $1::uuid
   AND reply.campaign_id = $2::uuid
   AND reply.id = $3::uuid`, tenantID, campaignID, replyID).
		Scan(campaignReplyScanTargets(&rep)...)
	if err != nil {
		return Reply{}, err
	}
	_ = db.Audit(r.Context(), tx,
		db.AuditMeta{TenantID: tenantID, ActorType: "system", ActorLabel: "campaign-replies"},
		"campaigns.reply_classified",
		"campaign_reply",
		replyID,
		map[string]any{
			"campaign_id":  campaignID,
			"reply_id":     replyID,
			"intent_label": intent.Label,
			"confidence":   intent.Confidence,
			"classifier":   intent.Classifier,
		},
	)
	return rep, tx.Commit(r.Context())
}

func normalizeIntentClassifierVersion(classifier string) string {
	classifier = normalizeIntentClassifier(classifier)
	switch classifier {
	case "heuristic":
		return "postwave.reply-intent-heuristic.v1"
	case "manual":
		return "postwave.reply-intent-manual.v1"
	default:
		return "postwave.reply-intent-ai.v1"
	}
}

func normalizeIntentClassifier(classifier string) string {
	switch classifier {
	case "ai", "heuristic", "manual":
		return classifier
	default:
		return "ai"
	}
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

func writeErr(w http.ResponseWriter, status int, code, msg string) {
	writeJSON(w, status, map[string]any{"error": map[string]string{"code": code, "message": msg}})
}
