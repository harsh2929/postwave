package campaigns

// Send-domain HTTP handlers: resend-to-non-openers, pause/resume/cancel,
// recurrence config. Mounted via MountSendDomain to keep them separated
// from the canonical CRUD handlers in handlers.go.

import (
	"errors"
	"net/http"
	"time"

	"github.com/go-chi/chi/v5"

	"github.com/postwave/postwave/apps/api/internal/apikeys"
	"github.com/postwave/postwave/apps/api/internal/campaignassurancegate"
	"github.com/postwave/postwave/apps/api/internal/httpbody"
	"github.com/postwave/postwave/apps/api/internal/httperror"
	"github.com/postwave/postwave/apps/api/internal/middleware"
)

// MountSendDomain registers the send-domain routes (resend-to-non-openers,
// pause/resume/cancel, recurrence config). Caller must mount under a
// tenant-scoped middleware group with apikeys auth.
func MountSendDomain(r chi.Router, d *Deps) {
	live := apikeys.RequireAllScopes(apikeys.ScopeWriteCampaigns, apikeys.ScopeSendTransactional)
	r.With(live).
		Post("/api/v1/campaigns/{id}/resend-to-non-openers", d.ResendToNonOpeners)
	r.With(live).
		Post("/api/v1/campaigns/{id}/recurrence", d.SetRecurrence)
	r.With(apikeys.RequireScope(apikeys.ScopeWriteCampaigns)).
		Post("/api/v1/campaigns/{id}/pause", d.PauseCampaign)
	r.With(live).
		Post("/api/v1/campaigns/{id}/resume", d.ResumeCampaign)
	r.With(apikeys.RequireScope(apikeys.ScopeWriteCampaigns)).
		Post("/api/v1/campaigns/{id}/cancel", d.CancelCampaign)
}

type resendInput struct {
	Subject string     `json:"subject"`
	SendAt  *time.Time `json:"send_at"`
}

type recurrenceInput struct {
	Cron  string     `json:"recurrence_cron"`
	Until *time.Time `json:"recurrence_until"`
}

// ResendToNonOpeners POST /api/v1/campaigns/{id}/resend-to-non-openers
//
// Clones the parent campaign and enqueues only the subscribers who
// received it but did not open. Returns the new (clone) campaign and
// the count of recipients queued.
func (d *Deps) ResendToNonOpeners(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		httperror.Write(w, http.StatusUnauthorized, "no_tenant", "tenant required")
		return
	}
	parentID := chi.URLParam(r, "id")
	var in resendInput
	if r.Body != nil {
		if err := httpbody.DecodeJSONWith(w, r, campaignJSONMaxBodyBytes, &in, httpbody.Options{AllowEmptyBody: true}); err != nil {
			httperror.Write(w, httpbody.StatusCode(err), httpbody.ErrorCode(err), httpbody.PublicMessage(err))
			return
		}
	}
	// This legacy route clones and enqueues directly, so it cannot produce the
	// clone-scoped immutable revision, send plan, and exact assurance receipt
	// required by the governed raw-MIME path. Never let it become a side door
	// around queueCampaignCore when Campaign Assurance enforcement is active.
	// The safe workflow is to duplicate the campaign as a draft, assure that
	// clone's exact artifact, then queue it through the canonical endpoint.
	if d != nil && d.campaignAssuranceRolloutMode() != campaignassurancegate.RolloutOff {
		httperror.Write(w, http.StatusConflict, "campaign_assurance_required_for_resend",
			"resend-to-non-openers requires a clone-specific Campaign Assurance run; create the resend draft, assure its exact revision, then use the canonical campaign queue")
		return
	}
	if err := d.checkLiveDispatch(r.Context(), t.ID); err != nil {
		writeLiveDispatchError(w, err)
		return
	}
	if paused, reason, err := d.emailSendingPaused(r.Context(), t.ID); err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	} else if paused {
		msg := "email sending is paused by tenant kill switch"
		if reason != "" {
			msg += ": " + reason
		}
		httperror.Write(w, http.StatusLocked, "email_sending_paused", msg)
		return
	}
	emails, err := d.Repo.NonOpenerEmails(r.Context(), t.ID, parentID)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	clone, err := d.Repo.CreateClone(r.Context(), t.ID, parentID, in.Subject, in.SendAt)
	if err != nil {
		if errors.Is(err, ErrNotFound) {
			httperror.Write(w, http.StatusNotFound, "not_found", "campaign not found")
			return
		}
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	enq, err := d.Repo.EnqueueRecipients(r.Context(), t.ID, clone.ID, emails)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"campaign":          clone,
		"recipients_queued": enq,
		"non_openers_total": len(emails),
	})
}

// SetRecurrence POST /api/v1/campaigns/{id}/recurrence
//
// Sets or clears recurrence_cron + recurrence_until. Validates the cron
// expression up-front so we never persist an unparseable value.
func (d *Deps) SetRecurrence(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		httperror.Write(w, http.StatusUnauthorized, "no_tenant", "tenant required")
		return
	}
	// Recurrence decides how often the campaign sends from now on — an edit to
	// the send itself, not an operator action on one in flight.
	if d.refuseIfLeaseHeld(w, r, t.ID, chi.URLParam(r, "id")) {
		return
	}
	var in recurrenceInput
	if err := httpbody.DecodeJSON(w, r, campaignJSONMaxBodyBytes, &in); err != nil {
		httperror.Write(w, httpbody.StatusCode(err), httpbody.ErrorCode(err), httpbody.PublicMessage(err))
		return
	}
	if in.Cron != "" {
		if _, err := ParseCron(in.Cron); err != nil {
			httperror.WriteValidation(w, "bad_cron", err.Error())
			return
		}
	}
	// Clearing recurrence is risk-reducing and remains available while all
	// dispatch interlocks are closed. Creating/updating recurrence intent can
	// materialize scheduled children, so it requires both live-dispatch policy
	// and the shared scheduler qualification/runtime gate.
	if in.Cron != "" {
		if err := d.checkLiveDispatch(r.Context(), t.ID); err != nil {
			writeLiveDispatchError(w, err)
			return
		}
		if err := d.checkScheduledMaterialization(); err != nil {
			writeScheduledMaterializationError(w, err)
			return
		}
	}
	c, err := d.Repo.SetRecurrence(r.Context(), t.ID, chi.URLParam(r, "id"), in.Cron, in.Until)
	if err != nil {
		if errors.Is(err, ErrNotFound) {
			httperror.Write(w, http.StatusNotFound, "not_found", "campaign not found")
			return
		}
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	writeJSON(w, http.StatusOK, c)
}

// PauseCampaign POST /api/v1/campaigns/{id}/pause
func (d *Deps) PauseCampaign(w http.ResponseWriter, r *http.Request) {
	d.transitionStatus(w, r, []string{StatusSending, StatusScheduled}, StatusPaused)
}

// ResumeCampaign POST /api/v1/campaigns/{id}/resume
func (d *Deps) ResumeCampaign(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		httperror.Write(w, http.StatusUnauthorized, "no_tenant", "tenant required")
		return
	}
	if err := d.checkLiveDispatch(r.Context(), t.ID); err != nil {
		writeLiveDispatchError(w, err)
		return
	}
	if paused, reason, err := d.emailSendingPaused(r.Context(), t.ID); err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	} else if paused {
		msg := "email sending is paused by tenant kill switch"
		if reason != "" {
			msg += ": " + reason
		}
		httperror.Write(w, http.StatusLocked, "email_sending_paused", msg)
		return
	}
	d.transitionStatus(w, r, []string{StatusPaused}, StatusSending)
}

// CancelCampaign POST /api/v1/campaigns/{id}/cancel
func (d *Deps) CancelCampaign(w http.ResponseWriter, r *http.Request) {
	d.transitionStatus(w, r,
		[]string{StatusDraft, StatusScheduled, StatusSending, StatusPaused},
		StatusCancelled)
}

func (d *Deps) transitionStatus(w http.ResponseWriter, r *http.Request, from []string, to string) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		httperror.Write(w, http.StatusUnauthorized, "no_tenant", "tenant required")
		return
	}
	c, err := d.Repo.SetStatus(r.Context(), t.ID, chi.URLParam(r, "id"), from, to)
	if err != nil {
		if errors.Is(err, ErrInvalidTransition) {
			httperror.Write(w, http.StatusConflict, "invalid_transition",
				"campaign not in a state that allows this action")
			return
		}
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	writeJSON(w, http.StatusOK, c)
}
