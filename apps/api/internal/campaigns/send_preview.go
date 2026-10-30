// SPDX-License-Identifier: AGPL-3.0-only
package campaigns

import (
	"context"
	"errors"
	"net/http"
	"time"

	"github.com/go-chi/chi/v5"

	"github.com/postwave/postwave/apps/api/internal/apikeys"
	"github.com/postwave/postwave/apps/api/internal/httperror"
	"github.com/postwave/postwave/apps/api/internal/middleware"
)

// SendPreviewResponse describes who would actually receive a campaign
// if the operator clicked Send right now. Surfaced in the desktop
// send-confirm modal so the operator no longer hits Send blind.
//
// Wire contract — fields with -1 as a value mean "unavailable" rather
// than "zero". The desktop renders these as a "—" / dash so the
// operator sees the gap rather than an inflated zero.
type SendPreviewResponse struct {
	CampaignID   string `json:"campaign_id"`
	AudienceKind string `json:"audience_kind"` // "segment" | "list" | "workspace"
	// AudienceLabel is the name of the list or segment the campaign sends to.
	// Empty for a workspace audience, or when the name could not be read —
	// clients then fall back to a phrase for the kind ("Selected list"),
	// never to an id.
	AudienceLabel string `json:"audience_label,omitempty"`
	// SegmentLabel repeats AudienceLabel for segment audiences only. Older
	// desktop and mobile builds read this field and nothing else.
	SegmentLabel string `json:"segment_label,omitempty"`
	// AudienceFrozen is true when the send goes to a frozen snapshot of the
	// audience rather than its current members.
	AudienceFrozen     bool      `json:"audience_frozen,omitempty"`
	Recipients         int64     `json:"recipients"`
	SuppressedExcluded int64     `json:"suppressed_excluded"`      // -1 sentinel when the suppression resolve timed out
	Deliverable        int64     `json:"deliverable"`              // max(0, recipients - suppressed) when known
	TierCapToday       int       `json:"tier_cap_today"`           // -1 = no cap (Pro tier / warmup complete)
	TierCapRemaining   int       `json:"tier_cap_remaining"`       // -1 when no cap
	TierCapRemainAfter int       `json:"tier_cap_remaining_after"` // -1 when no cap
	OverCap            bool      `json:"over_cap"`
	CountedAt          time.Time `json:"counted_at"`
}

// (SuppressionLookup interface is declared in handlers_queue.go in
// this package — the queue-fill path needs the same narrow shape, and
// re-declaring it here would conflict.)

// WarmupGateExt extends WarmupGate with the "how many have I already
// sent today" reading the preview needs to compute the remaining cap.
// We do NOT widen the WarmupGate interface itself because the existing
// send path doesn't need this read — keeping it on a separate optional
// interface lets existing implementations stay unchanged. A
// SendPreviewDeps without an ExtendedWarmup just shows the cap without
// the "remaining after" math.
type WarmupGateExt interface {
	WarmupGate
	// SentToday returns the number of messages tenantID has already
	// sent today. Returns 0 and nil error when the tracker doesn't
	// track today's count (older backends).
	SentToday(ctx context.Context, tenantID string) (int, error)
}

// SendPreviewDeps bundles the collaborators the preview handler needs.
// Audience remains for construction compatibility with older wiring; the
// preview population itself now comes from Repo.ResolveCampaignAudience, the
// same canonical email set queue-fill consumes, and the audience's name from
// the same Repo (see audience_label.go), so no wiring here can leave the
// review showing an id.
type SendPreviewDeps struct {
	Repo         *Repo
	Audience     AudienceCounter
	Warmup       WarmupGate
	Suppressions SuppressionLookup
}

// previewBudget caps the suppression-resolve work the preview handler
// will do before degrading to a recipients-only response. Large
// audiences resolve through bulk lookups but we still keep a guard.
const previewBudget = 3 * time.Second

// MountSendPreview wires GET /api/v1/campaigns/{id}/send-preview.
// Auth: ScopeReadCampaigns — a viewer can ask "what would happen if
// I sent this", which is the same role gate as the rest of the
// read-only campaign surface. Mutation is still gated on Send by the
// existing send route.
func MountSendPreview(r chi.Router, base *Deps, sp *SendPreviewDeps) {
	if base == nil || base.Repo == nil || sp == nil || sp.Repo == nil {
		return
	}
	h := &sendPreviewHandler{Base: base, Deps: sp}
	r.With(apikeys.RequireScope(apikeys.ScopeReadCampaigns)).
		Get("/api/v1/campaigns/{id}/send-preview", h.handle)
}

type sendPreviewHandler struct {
	Base *Deps
	Deps *SendPreviewDeps
}

func (h *sendPreviewHandler) handle(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeJSON(w, http.StatusUnauthorized, errEnv("no_tenant", "tenant required"))
		return
	}
	id := chi.URLParam(r, "id")
	c, err := h.Base.Repo.Get(r.Context(), t.ID, id)
	if err != nil {
		if errors.Is(err, ErrNotFound) {
			writeJSON(w, http.StatusNotFound, errEnv("not_found", "campaign not found"))
			return
		}
		httperror.WriteInternal(w, h.Base.Logger, err, r.Context())
		return
	}

	resp := SendPreviewResponse{
		CampaignID:         id,
		CountedAt:          time.Now().UTC(),
		SuppressedExcluded: -1,
		TierCapToday:       -1,
		TierCapRemaining:   -1,
		TierCapRemainAfter: -1,
	}

	// 1. Resolve the exact same activation-time email set queue-fill will use.
	// This is deliberately not a separate COUNT adapter: a list lookup failure
	// must fail closed here and at Send, never count zero here while Send falls
	// through to a workspace-wide blank-segment query.
	resolved, err := h.Base.Repo.ResolveCampaignAudience(r.Context(), t.ID, c)
	if err != nil {
		qe := queueAudienceError(err)
		if qe.Status >= http.StatusInternalServerError {
			httperror.WriteInternal(w, h.Base.Logger, qe.Err, r.Context())
		} else {
			httperror.Write(w, qe.Status, qe.Code, qe.Message)
		}
		return
	}
	resp.AudienceKind = string(resolved.Kind)
	resp.AudienceFrozen = resolved.Frozen
	resp.Recipients = int64(len(resolved.Emails))
	// The name of the source the campaign names. A frozen campaign whose
	// segment was later cleared resolves as a segment audience with no named
	// segment, so its label stays empty and the client says "Selected segment".
	if label := h.Base.Repo.campaignAudienceLabel(r.Context(), t.ID, c); label.Kind == resolved.Kind {
		resp.AudienceLabel = label.Name
		if resolved.Kind == CampaignAudienceSegment {
			resp.SegmentLabel = label.Name
		}
	}

	// 2. Suppression delta. Bounded by previewBudget so a giant audience
	// + slow suppressions DB don't hang the modal. On timeout we keep
	// the sentinel -1 and the desktop renders "—" for the suppression
	// row rather than misleading the operator with 0.
	if h.Deps.Suppressions != nil {
		ctx, cancel := context.WithTimeout(r.Context(), previewBudget)
		hits, lookupErr := h.Deps.Suppressions.LookupBulk(ctx, t.ID, resolved.Emails)
		if lookupErr == nil {
			kept := filterOutSuppressed(resolved.Emails, hits)
			resp.SuppressedExcluded = int64(len(resolved.Emails) - len(kept))
			resp.Deliverable = int64(len(kept))
		}
		cancel()
	}
	if resp.SuppressedExcluded < 0 {
		// Couldn't compute suppression. Fall back to recipients as
		// the deliverable estimate — operators see "N recipients"
		// with no exclusion delta, matching the old behaviour but
		// at least surfacing the count.
		resp.Deliverable = resp.Recipients
	}

	// 3. Warmup tier cap. Only the extended warmup interface gives us
	// today's sent count for the "remaining" math; nil-safe fallback
	// keeps the preview useful on dev wiring without a warmup tracker.
	if h.Deps.Warmup != nil {
		cap, err := h.Deps.Warmup.CapForToday(r.Context(), t.ID)
		if err == nil {
			resp.TierCapToday = cap
			if cap >= 0 {
				resp.TierCapRemaining = cap
				if ext, ok := h.Deps.Warmup.(WarmupGateExt); ok {
					if sent, err := ext.SentToday(r.Context(), t.ID); err == nil {
						resp.TierCapRemaining = cap - sent
						if resp.TierCapRemaining < 0 {
							resp.TierCapRemaining = 0
						}
					}
				}
				resp.TierCapRemainAfter = resp.TierCapRemaining - int(resp.Deliverable)
				if resp.TierCapRemainAfter < 0 {
					resp.TierCapRemainAfter = 0
				}
				resp.OverCap = int(resp.Deliverable) > resp.TierCapRemaining
			}
		}
	}

	writeJSON(w, http.StatusOK, resp)
}
