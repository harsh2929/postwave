// SPDX-License-Identifier: AGPL-3.0-only
//
// smart_unsubscribe.go — preference-center extension that lets a
// subscriber pick a lower frequency or temporary pause instead of
// the all-or-nothing unsubscribe. Paired with the per-subscriber
// churn-risk score (migration 0180); operators link to this from
// every campaign's unsubscribe footer.
//
// The frequency_preference column is a HINT — the sender path
// reads it before scheduling a campaign send. Compliance still
// flows through the suppression list (unchanged); this is a
// retention lever sitting in front of unsubscribe, not a
// replacement for it.

package preferences

import (
	"context"

	"errors"
	"net/http"
	"time"

	"github.com/go-chi/chi/v5"

	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/httpbody"
	"github.com/postwave/postwave/apps/api/internal/httperror"
)

// FrequencyChoice is the subscriber-facing pick on the smart-
// unsubscribe page. Mirrors the CHECK constraint on
// subscribers.frequency_preference (migration 0180).
type FrequencyChoice string

const (
	FreqDefault FrequencyChoice = "default"
	FreqWeekly  FrequencyChoice = "weekly"
	FreqMonthly FrequencyChoice = "monthly"
	FreqPaused  FrequencyChoice = "paused"
)

// SmartUnsubscribeInput is the body of POST /api/public/preferences/{token}/frequency.
type SmartUnsubscribeInput struct {
	Choice FrequencyChoice `json:"choice"`
	// PauseDays — only honoured when Choice == "paused". Bounded
	// 1..365; the server clamps + auto-resumes when paused_until
	// elapses (the sender path checks paused_until each tick).
	PauseDays int `json:"pauseDays,omitempty"`
}

// SmartUnsubscribeResponse echoes the persisted state so the page
// can render confirmation copy.
type SmartUnsubscribeResponse struct {
	Choice      FrequencyChoice `json:"choice"`
	PausedUntil *time.Time      `json:"pausedUntil,omitempty"`
}

// UpdateSmartUnsubscribe writes the subscriber's frequency preference
// + paused_until. Idempotent. Bounds-checks the input.
func (r *Repo) UpdateSmartUnsubscribe(ctx context.Context, tenantID, subscriberEmail string, in SmartUnsubscribeInput) (SmartUnsubscribeResponse, error) {
	switch in.Choice {
	case FreqDefault, FreqWeekly, FreqMonthly, FreqPaused:
	default:
		return SmartUnsubscribeResponse{}, errors.New("preferences: invalid frequency choice")
	}
	var pausedUntil *time.Time
	if in.Choice == FreqPaused {
		days := in.PauseDays
		if days < 1 {
			days = 30
		}
		if days > 365 {
			days = 365
		}
		t := time.Now().UTC().Add(time.Duration(days) * 24 * time.Hour)
		pausedUntil = &t
	}
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return SmartUnsubscribeResponse{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, `
UPDATE subscribers
   SET frequency_preference = $1,
       paused_until = $2
 WHERE tenant_id = $3::uuid AND email = $4`,
		string(in.Choice), pausedUntil, tenantID, subscriberEmail); err != nil {
		return SmartUnsubscribeResponse{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return SmartUnsubscribeResponse{}, err
	}
	return SmartUnsubscribeResponse{
		Choice:      in.Choice,
		PausedUntil: pausedUntil,
	}, nil
}

// PublicSmartUnsubscribe POST /api/public/preferences/{token}/frequency.
// Token-gated (preference_tokens), no auth header required.
func (d *Deps) PublicSmartUnsubscribe(w http.ResponseWriter, r *http.Request) {
	token := chi.URLParam(r, "token")
	if token == "" {
		writeJSON(w, http.StatusBadRequest, errEnv("missing_token", ""))
		return
	}
	pt, err := d.Repo.LookupToken(r.Context(), token)
	if err != nil {
		switch {
		case errors.Is(err, ErrTokenExpired):
			writeJSON(w, http.StatusGone, errEnv("token_expired", "preference link expired"))
		case errors.Is(err, ErrNotFound):
			writeJSON(w, http.StatusNotFound, errEnv("not_found", "no such token"))
		default:
			httperror.WriteInternal(w, d.Logger, err, r.Context())
		}
		return
	}
	var in SmartUnsubscribeInput
	if err := httpbody.DecodeJSON(w, r, 4<<10, &in); err != nil {
		httpbody.WriteError(w, err)
		return

	}
	out, err := d.Repo.UpdateSmartUnsubscribe(r.Context(), pt.TenantID, pt.SubscriberEmail, in)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	writeJSON(w, http.StatusOK, out)
}
