// SPDX-License-Identifier: AGPL-3.0-only

package campaigns

import (
	"context"
	"errors"
	"net/http"
	"strconv"
	"strings"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"

	"github.com/postwave/postwave/apps/api/internal/campaignartifact"
	"github.com/postwave/postwave/apps/api/internal/httpcache"
	"github.com/postwave/postwave/apps/api/internal/httperror"
	"github.com/postwave/postwave/apps/api/internal/middleware"
)

// CampaignArtifactStore is the narrow immutable-revision boundary used by the
// campaign HTTP surface. The concrete repository owns tenant transactions and
// RLS; the interface keeps path/error behavior testable without PostgreSQL.
type CampaignArtifactStore interface {
	FreezeCurrent(ctx context.Context, tenantID, campaignID, actorID string) (*campaignartifact.Revision, error)
	ListRevisions(ctx context.Context, tenantID, campaignID string, limit int) ([]campaignartifact.RevisionSummary, error)
	GetRevision(ctx context.Context, tenantID, campaignID, revisionID string) (*campaignartifact.Revision, error)
}

func contentRevisionRequest(
	w http.ResponseWriter,
	r *http.Request,
	requireRevision bool,
) (tenantID, campaignID, revisionID string, ok bool) {
	tenant, found := middleware.TenantFromContext(r.Context())
	if !found {
		writeJSON(w, http.StatusUnauthorized, errEnv("no_tenant", "tenant required"))
		return "", "", "", false
	}
	campaignID = strings.TrimSpace(chi.URLParam(r, "id"))
	if _, err := uuid.Parse(campaignID); err != nil {
		writeJSON(w, http.StatusBadRequest, errEnv("invalid_campaign_id", "campaign id must be a UUID"))
		return "", "", "", false
	}
	if requireRevision {
		revisionID = strings.TrimSpace(chi.URLParam(r, "revisionID"))
		if _, err := uuid.Parse(revisionID); err != nil {
			writeJSON(w, http.StatusBadRequest, errEnv("invalid_revision_id", "revision id must be a UUID"))
			return "", "", "", false
		}
	}
	return tenant.ID, campaignID, revisionID, true
}

func (d *Deps) requireArtifactStore(w http.ResponseWriter) bool {
	if d != nil && d.Artifacts != nil {
		return true
	}
	writeJSON(w, http.StatusServiceUnavailable, errEnv(
		"campaign_artifacts_unavailable",
		"immutable campaign revisions are temporarily unavailable",
	))
	return false
}

func (d *Deps) writeContentRevisionError(w http.ResponseWriter, r *http.Request, err error) {
	switch {
	case errors.Is(err, campaignartifact.ErrNotFound):
		// Keep a cross-tenant campaign/revision indistinguishable from a missing
		// resource; the repository also proves both parent identities in SQL.
		writeJSON(w, http.StatusNotFound, errEnv("not_found", "campaign revision not found"))
	case errors.Is(err, campaignartifact.ErrSourceIncomplete):
		writeJSON(w, http.StatusUnprocessableEntity, errEnv(
			"campaign_source_incomplete",
			"the campaign needs semantic nodes or legacy HTML before it can be frozen",
		))
	case writeCampaignSemanticError(w, err):
		return
	default:
		httperror.WriteInternal(w, d.Logger, err, r.Context())
	}
}

// FreezeContentRevision snapshots the current mutable draft. Repeating the
// call without changing canonical source returns the same revision identity;
// this makes retries safe without manufacturing an idempotency key.
func (d *Deps) FreezeContentRevision(w http.ResponseWriter, r *http.Request) {
	tenantID, campaignID, _, ok := contentRevisionRequest(w, r, false)
	if !ok || !d.requireArtifactStore(w) {
		return
	}
	actorID := ""
	if user, found := middleware.UserFromContext(r.Context()); found && user != nil {
		if _, err := uuid.Parse(user.ID); err == nil {
			actorID = user.ID
		}
	}
	revision, err := d.Artifacts.FreezeCurrent(r.Context(), tenantID, campaignID, actorID)
	if err != nil {
		d.writeContentRevisionError(w, r, err)
		return
	}
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("ETag", httpcache.ETagStrong("campaign-revision", revision.ID, revision.RevisionNo))
	writeJSON(w, http.StatusOK, revision)
}

func (d *Deps) ListContentRevisions(w http.ResponseWriter, r *http.Request) {
	tenantID, campaignID, _, ok := contentRevisionRequest(w, r, false)
	if !ok || !d.requireArtifactStore(w) {
		return
	}
	limit := 50
	if raw := strings.TrimSpace(r.URL.Query().Get("limit")); raw != "" {
		parsed, err := strconv.Atoi(raw)
		if err != nil || parsed < 1 || parsed > 100 {
			writeJSON(w, http.StatusBadRequest, errEnv("invalid_limit", "limit must be between 1 and 100"))
			return
		}
		limit = parsed
	}
	revisions, err := d.Artifacts.ListRevisions(r.Context(), tenantID, campaignID, limit)
	if err != nil {
		d.writeContentRevisionError(w, r, err)
		return
	}
	w.Header().Set("Cache-Control", "private, no-cache")
	writeJSON(w, http.StatusOK, revisions)
}

func (d *Deps) GetContentRevision(w http.ResponseWriter, r *http.Request) {
	tenantID, campaignID, revisionID, ok := contentRevisionRequest(w, r, true)
	if !ok || !d.requireArtifactStore(w) {
		return
	}
	revision, err := d.Artifacts.GetRevision(r.Context(), tenantID, campaignID, revisionID)
	if err != nil {
		d.writeContentRevisionError(w, r, err)
		return
	}
	etag := httpcache.ETagStrong("campaign-revision", revision.ID, revision.RevisionNo)
	w.Header().Set("Cache-Control", "private, max-age=31536000, immutable")
	if httpcache.IfNoneMatch(w, r, etag) {
		return
	}
	writeJSON(w, http.StatusOK, revision)
}
