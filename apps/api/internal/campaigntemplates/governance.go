// SPDX-License-Identifier: AGPL-3.0-only

package campaigntemplates

import (
	"context"
	"errors"
	"net/http"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5"

	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/httpbody"
	"github.com/postwave/postwave/apps/api/internal/httperror"
	"github.com/postwave/postwave/apps/api/internal/middleware"
)

const maxReferenceReviewNoteRunes = 2000

// ReferenceReviewDecisionInput creates one immutable review receipt. Approval
// rights are independent: adaptation may be allowed while captured source
// content remains forbidden for direct use.
type ReferenceReviewDecisionInput struct {
	Decision          string `json:"decision"`
	AdaptationAllowed bool   `json:"adaptation_allowed"`
	DirectUseAllowed  bool   `json:"direct_use_allowed"`
	Note              string `json:"note"`
}

// ReferenceReviewActor is derived from authenticated request context rather
// than accepted from the caller.
type ReferenceReviewActor struct {
	Type  string
	ID    string
	Label string
}

type ReferenceReviewDecision struct {
	ID                  string    `json:"id"`
	TemplateID          string    `json:"template_id"`
	Decision            string    `json:"decision"`
	AdaptationAllowed   bool      `json:"adaptation_allowed"`
	DirectUseAllowed    bool      `json:"direct_use_allowed"`
	Note                string    `json:"note"`
	SourceContentHash   string    `json:"source_content_hash"`
	SourceLicenseStatus string    `json:"source_license_status"`
	ActorType           string    `json:"actor_type"`
	ActorID             string    `json:"actor_id"`
	ActorLabel          string    `json:"actor_label,omitempty"`
	CreatedAt           time.Time `json:"created_at"`
}

type ReferenceReviewResult struct {
	Decision            ReferenceReviewDecision `json:"decision"`
	ReviewStatus        string                  `json:"review_status"`
	SourceLicenseStatus string                  `json:"source_license_status"`
}

func normalizeReferenceReviewInput(in ReferenceReviewDecisionInput) (ReferenceReviewDecisionInput, error) {
	in.Decision = strings.ToLower(strings.TrimSpace(in.Decision))
	in.Note = strings.TrimSpace(in.Note)
	if in.Decision != "approve" && in.Decision != "reject" {
		return ReferenceReviewDecisionInput{}, ErrInvalidReviewDecision
	}
	if in.Note == "" || utf8.RuneCountInString(in.Note) > maxReferenceReviewNoteRunes {
		return ReferenceReviewDecisionInput{}, ErrInvalidReviewDecision
	}
	if in.Decision == "reject" && (in.AdaptationAllowed || in.DirectUseAllowed) {
		return ReferenceReviewDecisionInput{}, ErrInvalidReviewDecision
	}
	if in.Decision == "approve" && !in.AdaptationAllowed && !in.DirectUseAllowed {
		return ReferenceReviewDecisionInput{}, ErrInvalidReviewDecision
	}
	return in, nil
}

func normalizeReferenceReviewActor(actor ReferenceReviewActor) (ReferenceReviewActor, error) {
	actor.Type = strings.ToLower(strings.TrimSpace(actor.Type))
	actor.ID = strings.TrimSpace(actor.ID)
	actor.Label = strings.TrimSpace(actor.Label)
	switch actor.Type {
	case "user", "api_key", "service":
	default:
		return ReferenceReviewActor{}, ErrReviewActorRequired
	}
	if actor.ID == "" || len(actor.ID) > 512 || len(actor.Label) > 512 {
		return ReferenceReviewActor{}, ErrReviewActorRequired
	}
	return actor, nil
}

func referenceReviewActorFromContext(ctx context.Context) (ReferenceReviewActor, error) {
	if middleware.IsAPIKeyAuth(ctx) {
		actorType, label := middleware.ActorFromContext(ctx)
		id := strings.TrimSpace(middleware.APIKeyIDFromContext(ctx))
		if id == "" {
			id = strings.TrimSpace(label)
		}
		kind := "api_key"
		if strings.EqualFold(strings.TrimSpace(actorType), "service") {
			kind = "service"
		}
		return normalizeReferenceReviewActor(ReferenceReviewActor{Type: kind, ID: id, Label: label})
	}
	if user, ok := middleware.UserFromContext(ctx); ok && user != nil {
		return normalizeReferenceReviewActor(ReferenceReviewActor{
			Type: "user", ID: user.ID, Label: user.Email,
		})
	}
	return ReferenceReviewActor{}, ErrReviewActorRequired
}

// ReviewReference atomically appends an immutable audit receipt and advances
// the reference's current permission pointer. It never changes
// source_license_status. Imported references can therefore become valid
// inspiration without being misrepresented as owned content.
func (r *Repo) ReviewReference(
	ctx context.Context,
	tenantID, templateID string,
	in ReferenceReviewDecisionInput,
	actor ReferenceReviewActor,
) (*ReferenceReviewResult, error) {
	in, err := normalizeReferenceReviewInput(in)
	if err != nil {
		return nil, err
	}
	actor, err = normalizeReferenceReviewActor(actor)
	if err != nil {
		return nil, err
	}
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	var kind, license, contentHash string
	err = tx.QueryRow(ctx, `
SELECT template_kind, source_license_status, content_hash
  FROM campaign_templates
 WHERE tenant_id = $1::uuid
   AND id::text = $2
 FOR UPDATE`, tenantID, templateID).Scan(&kind, &license, &contentHash)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	if kind != templateKindReference {
		return nil, ErrReferenceReviewTarget
	}
	if in.DirectUseAllowed && license != licenseStatusOwned {
		return nil, ErrDirectUseLicenseRequired
	}

	var decision ReferenceReviewDecision
	err = tx.QueryRow(ctx, `
INSERT INTO campaign_template_reference_review_decisions
       (tenant_id, template_id, decision, adaptation_allowed,
        direct_use_allowed, note, source_content_hash,
        source_license_status, actor_type, actor_id, actor_label)
VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6, $7, $8, $9, $10, $11)
RETURNING id::text, template_id::text, decision, adaptation_allowed,
          direct_use_allowed, note, source_content_hash,
          source_license_status, actor_type, actor_id, actor_label, created_at`,
		tenantID, templateID, in.Decision, in.AdaptationAllowed,
		in.DirectUseAllowed, in.Note, contentHash, license,
		actor.Type, actor.ID, actor.Label,
	).Scan(
		&decision.ID, &decision.TemplateID, &decision.Decision,
		&decision.AdaptationAllowed, &decision.DirectUseAllowed, &decision.Note,
		&decision.SourceContentHash, &decision.SourceLicenseStatus,
		&decision.ActorType, &decision.ActorID, &decision.ActorLabel,
		&decision.CreatedAt,
	)
	if err != nil {
		return nil, err
	}

	reviewStatus := reviewStatusApproved
	if in.Decision == "reject" {
		reviewStatus = reviewStatusRejected
	}
	var applied bool
	err = tx.QueryRow(ctx, `
SELECT campaign_template_apply_reference_review($1::uuid, $2::uuid, $3::uuid)`,
		tenantID, templateID, decision.ID,
	).Scan(&applied)
	if err != nil {
		return nil, err
	}
	if !applied {
		return nil, ErrReferenceReviewTarget
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return &ReferenceReviewResult{
		Decision: decision, ReviewStatus: reviewStatus, SourceLicenseStatus: license,
	}, nil
}

// ReviewReferenceDecision handles the admin-scoped append-only transition.
func (d *Deps) ReviewReferenceDecision(w http.ResponseWriter, r *http.Request) {
	tenant, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		httperror.Write(w, http.StatusUnauthorized, "no_tenant", "")
		return
	}
	actor, err := referenceReviewActorFromContext(r.Context())
	if err != nil {
		httperror.Write(w, http.StatusUnauthorized, "review_actor_required",
			"An authenticated dashboard user or API key is required for an audited review.")
		return
	}
	var in ReferenceReviewDecisionInput
	if err := httpbody.DecodeJSON(w, r, campaignTemplateJSONMaxBodyBytes, &in); err != nil {
		httperror.Write(w, httpbody.StatusCode(err), httpbody.ErrorCode(err), httpbody.PublicMessage(err))
		return
	}
	if _, err := normalizeReferenceReviewInput(in); err != nil {
		httperror.WriteValidation(w, "invalid_review_decision",
			"decision, permissions, and a review note must form a valid approve or reject decision")
		return
	}
	out, err := d.Repo.ReviewReference(
		r.Context(), tenant.ID, chi.URLParam(r, "id"), in, actor,
	)
	if err != nil {
		switch {
		case errors.Is(err, ErrNotFound):
			httperror.Write(w, http.StatusNotFound, "not_found", "")
		case errors.Is(err, ErrReferenceReviewTarget):
			httperror.Write(w, http.StatusUnprocessableEntity, "reference_required",
				"Only tenant-owned reference templates can receive a reference review decision.")
		case errors.Is(err, ErrDirectUseLicenseRequired):
			httperror.Write(w, http.StatusUnprocessableEntity, "direct_use_license_required",
				"Direct use can only be granted when the source license is already recorded as owned.")
		case errors.Is(err, ErrInvalidReviewDecision):
			httperror.WriteValidation(w, "invalid_review_decision", "The review decision is invalid.")
		default:
			httperror.WriteInternal(w, d.Logger, err, r.Context())
		}
		return
	}
	writeJSON(w, http.StatusCreated, out)
}
