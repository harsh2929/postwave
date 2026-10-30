// SUB-066 — Personalized per-recipient send-time, PER CHANNEL.
//
// subscribers.best_send_hour (migration 0076) stores ONE modal
// hour-of-week (0-167) aggregated across all channels. The optimal time
// to reach a person on email is rarely the optimal time on SMS or push,
// so migration 0936 extends subscriber_channel_consents (the unified
// per-channel consent table, 0488) with per-channel best_send_hour /
// best_send_hour_at columns.
//
// This surface is the READ path: it exposes, for one subscriber, every
// per-channel optimal window alongside the legacy per-subscriber
// aggregate. The compute path (the modal-hour worker) lives in the
// send_time_opt package and is out of scope for this file — this file
// only reads what has been written and presents it.
//
// Endpoint (scoped under an existing subscriber id):
//   GET /api/v1/subscribers/{id}/send-times — per-channel windows + aggregate

package subscribers

import (
	"context"
	"errors"
	"net/http"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5"

	"github.com/postwave/postwave/apps/api/internal/apikeys"
	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/httperror"
	"github.com/postwave/postwave/apps/api/internal/middleware"
)

// MountSendTimesRoutes registers the SUB-066 per-channel send-time read
// endpoint. Read-subscribers scoped. Kept a separate group so main.go can
// opt in inside the subscriber-drilldown region.
func MountSendTimesRoutes(r chi.Router, d *Deps) {
	r.With(apikeys.RequireScope(apikeys.ScopeReadSubscribers)).
		Get("/api/v1/subscribers/{id}/send-times", d.GetSendTimes)
}

// GetSendTimes GET /api/v1/subscribers/{id}/send-times
func (d *Deps) GetSendTimes(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeJSON(w, http.StatusUnauthorized, errEnv("no_tenant", "tenant required"))
		return
	}
	out, err := d.Repo.GetSendTimes(r.Context(), t.ID, chi.URLParam(r, "id"))
	if err != nil {
		if errors.Is(err, ErrNotFound) {
			writeJSON(w, http.StatusNotFound, errEnv("not_found", "subscriber not found"))
			return
		}
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), t.ID))
		return
	}
	writeJSON(w, http.StatusOK, out)
}

// GetSendTimes reads the per-channel optimal send windows for one
// subscriber from subscriber_channel_consents (migration 0936) plus the
// legacy per-subscriber aggregate from subscribers (migration 0076). It
// returns ErrNotFound when the subscriber does not exist / is not
// tenant-visible. Channels are ordered by channel name for stable output;
// a channel with a consent row but no computed hour has a nil
// BestSendHour (the caller falls back to the aggregate).
func (r *Repo) GetSendTimes(ctx context.Context, tenantID, subscriberID string) (*PerChannelSendTimes, error) {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	// Confirm the subscriber exists (and is tenant-visible) so a bogus id
	// 404s rather than returning an empty envelope.
	sub, err := getInTx(ctx, tx, tenantID, subscriberID)
	if err != nil {
		return nil, err
	}

	out := &PerChannelSendTimes{SubscriberID: sub.ID, Channels: []ChannelSendTime{}}

	// Legacy aggregate from subscribers.best_send_hour (0076).
	if err := tx.QueryRow(ctx, `
SELECT best_send_hour, best_send_hour_at
  FROM subscribers
 WHERE tenant_id = $1::uuid AND id = $2::uuid`, tenantID, sub.ID).
		Scan(&out.AggregateBestSendHour, &out.AggregateBestSendHourAt); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, ErrNotFound
		}
		return nil, err
	}

	// Per-channel windows from subscriber_channel_consents (0936).
	rows, err := tx.Query(ctx, `
SELECT channel, best_send_hour, best_send_hour_at
  FROM subscriber_channel_consents
 WHERE tenant_id = $1::uuid AND subscriber_id = $2::uuid
 ORDER BY channel ASC`, tenantID, sub.ID)
	if err != nil {
		return nil, err
	}
	channels, err := scanChannelSendTimes(rows)
	if err != nil {
		return nil, err
	}
	out.Channels = channels

	return out, tx.Commit(ctx)
}

func scanChannelSendTimes(rows pgx.Rows) ([]ChannelSendTime, error) {
	defer rows.Close()
	out := []ChannelSendTime{}
	for rows.Next() {
		var c ChannelSendTime
		if err := rows.Scan(&c.Channel, &c.BestSendHour, &c.BestSendHourAt); err != nil {
			return nil, err
		}
		// Derive the human-friendly day-of-week (0=Sun) + hour-of-day from
		// the 0-167 hour-of-week so the UI doesn't repeat the modulo math.
		c.DayOfWeek, c.HourOfDay = deriveDowHod(c.BestSendHour)
		out = append(out, c)
	}
	return out, rows.Err()
}

// deriveDowHod splits a 0-167 modal hour-of-week into (day_of_week,
// hour_of_day): dow = h/24 (0=Sunday), hod = h%24. Returns (nil, nil)
// when h is nil (not computed) so the JSON omits the derived fields. An
// out-of-range value is clamped defensively rather than panicking.
func deriveDowHod(h *int) (*int, *int) {
	if h == nil {
		return nil, nil
	}
	v := *h
	if v < 0 {
		v = 0
	}
	if v > 167 {
		v = 167
	}
	dow := v / 24
	hod := v % 24
	return &dow, &hod
}
